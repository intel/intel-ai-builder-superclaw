import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { request as httpRequest } from "node:http"

/**
 * The Connector client that sc_search_web and sc_fetch_url share.
 *
 * It reads the client configuration through the DPAPI reader, signs each request with the caller
 * key, posts it to the Connector on loopback, and returns a response body only after the response
 * envelope matches the request and its response-key MAC verifies. The wire is Connector IPC v2,
 * shared/contracts/src/connector-ipc.ts. This file restates it instead of importing it, because
 * a deployed Profile carries no package but @opencode-ai/plugin.
 */

export const CONNECTOR_CONTRACT_VERSION = 2

type ConnectorConfig = {
  contract_version: typeof CONNECTOR_CONTRACT_VERSION
  endpoint: string
  boot_id: string
  caller_key_id: string
  caller_key_b64: string
  response_key_id: string
  response_key_b64: string
}

type ConnectorMessage = Record<string, any>

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8")
  const output = Buffer.alloc(4 + bytes.length)
  output.writeUInt32BE(bytes.length, 0)
  bytes.copy(output, 4)
  return output
}

export function connectorMacPayload(message: ConnectorMessage): Buffer {
  const fields = [
    String(message.contract_version),
    message.operation,
    message.direction,
    message.caller_key_id,
    message.boot_id,
    message.session_id,
    message.request_id,
    message.nonce,
    message.direction === "response" ? message.response_key_id : "",
  ]
  const deadline = Buffer.alloc(8)
  deadline.writeBigUInt64BE(BigInt(message.deadline_ms))
  const bodyDigest = createHash("sha256").update(canonicalJson(message.body), "utf8").digest()
  return Buffer.concat([...fields.map(lengthPrefixed), deadline, bodyDigest])
}

function verifyConnectorConfig(value: any): ConnectorConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Connector client configuration is invalid")
  }
  const endpoint = new URL(value.endpoint ?? "")
  if (
    value.contract_version !== CONNECTOR_CONTRACT_VERSION ||
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/v1/connector" ||
    !/^caller_[a-z0-9]{16}$/.test(value.caller_key_id ?? "") ||
    !/^response_[a-z0-9]{16}$/.test(value.response_key_id ?? "")
  ) {
    throw new Error("Connector client configuration is invalid")
  }
  for (const field of ["caller_key_b64", "response_key_b64"] as const) {
    if (Buffer.from(value[field], "base64").length !== 32) {
      throw new Error(`Connector ${field} is invalid`)
    }
  }
  return value as ConnectorConfig
}

export function postLoopbackJson(
  endpoint: string,
  payload: string,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const target = new URL(endpoint)
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
    return Promise.reject(new Error("Connector endpoint is not loopback HTTP"))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    // egress-surface: profile_tools_connector
    const request = httpRequest(
      target,
      {
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on("data", (chunk: Buffer | Uint8Array) => {
          const bytes = Buffer.from(chunk)
          size += bytes.length
          if (size > 128 * 1024) {
            response.destroy(new Error("Connector response exceeded 128 KiB"))
            return
          }
          chunks.push(bytes)
        })
        response.on("error", fail)
        response.on("end", () => {
          if (settled) return
          settled = true
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          })
        })
      },
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Connector request timed out after ${timeoutMs} ms`))
    })
    request.on("error", fail)
    request.end(payload)
  })
}

export async function readConnectorConfig(configPath: string): Promise<ConnectorConfig> {
  // No bun-types ambient declarations are wired up for this standalone tool script, so the
  // global is narrowed through `unknown` to the one method this file calls instead of `any`.
  const bun = (globalThis as unknown as {
    Bun: {
      spawn(cmd: string[], options: Record<string, unknown>): {
        stdout: ReadableStream<Uint8Array>
        stderr: ReadableStream<Uint8Array>
        exited: Promise<number>
      }
    }
  }).Bun
  const python = process.env.SUPERCLAW_CONNECTOR_READER_PYTHON?.trim()
  const root = process.env.SUPERCLAW_CONNECTOR_READER_ROOT?.trim()
  if (!python || !root) throw new Error("Connector DPAPI reader is not configured")
  // windowsHide: true so this subprocess never flashes a console window on Windows,
  // same fix as sc_search_web's runPythonHelper.
  const processHandle = bun.spawn(
    [python, "-m", "sandbox_manager.dpapi_connector_reader", configPath],
    { cwd: root, stdout: "pipe", stderr: "pipe", env: process.env, windowsHide: true },
  )
  const output = await new Response(processHandle.stdout).text()
  const error = await new Response(processHandle.stderr).text()
  const exitCode = await processHandle.exited
  if (exitCode !== 0) throw new Error(error.trim() || "Connector DPAPI reader failed")
  return verifyConnectorConfig(JSON.parse(output))
}

/** Sends one request to the Connector and returns the body of its verified response. */
export async function callConnector(
  configPath: string,
  operation: string,
  body: Record<string, unknown>,
  sessionID: string | undefined,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const config = await readConnectorConfig(configPath)
  const request: ConnectorMessage = {
    contract_version: CONNECTOR_CONTRACT_VERSION,
    operation,
    direction: "request",
    caller_key_id: config.caller_key_id,
    boot_id: config.boot_id,
    session_id: sessionID || "anonymous",
    request_id: `${operation}-${randomUUID()}`,
    nonce: randomBytes(32).toString("base64url"),
    deadline_ms: Date.now() + timeoutMs,
    body,
    auth_tag: "0".repeat(64),
  }
  const callerKey = Buffer.from(config.caller_key_b64, "base64")
  request.auth_tag = createHmac("sha256", callerKey).update(connectorMacPayload(request)).digest("hex")

  const response = await postLoopbackJson(config.endpoint, JSON.stringify(request), timeoutMs)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Connector request failed with HTTP ${response.status}`)
  }
  const message: ConnectorMessage = JSON.parse(response.text)
  if (
    message.contract_version !== CONNECTOR_CONTRACT_VERSION ||
    message.operation !== operation ||
    message.direction !== "response" ||
    message.caller_key_id !== config.caller_key_id ||
    message.response_key_id !== config.response_key_id ||
    message.boot_id !== config.boot_id ||
    message.session_id !== request.session_id ||
    message.request_id !== request.request_id ||
    message.nonce !== request.nonce ||
    message.deadline_ms !== request.deadline_ms ||
    !/^[0-9a-f]{64}$/.test(message.auth_tag ?? "")
  ) {
    throw new Error("Connector response envelope did not match its request")
  }
  const responseKey = Buffer.from(config.response_key_b64, "base64")
  const expected = createHmac("sha256", responseKey).update(connectorMacPayload(message)).digest()
  const actual = Buffer.from(message.auth_tag, "hex")
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Connector response authentication failed")
  }
  return message.body
}

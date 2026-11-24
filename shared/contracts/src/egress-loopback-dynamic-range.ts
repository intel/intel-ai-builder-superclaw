/**
 * The loopback TCP gap an enforcing egress plan leaves open to every tier, and the one rule
 * that says which host ranges it may be (EG2-11). Defined here once; the planner, the Sandbox
 * Manager and the broker read it from the generated data and repeat none of it.
 *
 * WHY there is a gap: CPython's `socket.socketpair()` on Windows, and so asyncio's Proactor
 * self-pipe, is a loopback TCP connect to an ephemeral listener the same process just opened.
 * The connect lands on a port the plan cannot name. Real-machine `netsh wfp show netevents`
 * showed CLASSIFY_DROP at ALE_AUTH_CONNECT for `python.exe 127.0.0.1:N+1 -> 127.0.0.1:N` under
 * the bootstrap, file_tool and network_connector accounts before the gap existed. WFP cannot
 * scope a permit to the listener's account (`ALE_REMOTE_USER_ID` is IPsec-only), so the gap is
 * open to the tier, not to its own sockets.
 *
 * WHICH ports: the host's own IPv4 TCP dynamic range, because that is where the OS binds an
 * ephemeral port. A fixed 49152-65535 would not cover a host whose range was moved (Hyper-V and
 * other virtualization reservations, corporate images), and socketpair would fail at start-up again. Windows
 * defaults to 49152-65535, kept here as the documented default for tests and docs. IPv4 only:
 * `socketpair` is AF_INET, and no control service binds `::1`, so the IPv6 range is not read.
 * The ports are family-agnostic in the plan, so the same gap is open on `::1`.
 *
 * COST: a tier can connect to any other local user's or application's loopback listener inside
 * the range, an IDE language server for one. UDP stays blocked. The isolation report and the
 * negative-probe attestation say so (`loopback_open_tcp_range`).
 *
 * REFUSE, DO NOT SPLIT: if the host range holds a port the plan must keep blocked (every port
 * of every declared loopback endpoint, the host control ports sandbox_manager 18821 and
 * service_hub 18864-18867 among them), enforcement is refused with a typed reason. Carving the
 * control ports out of the gap would give one tier block per fragment and a plan nobody can
 * audit by reading its ranges; refusing is one rule, one reason, and the shipped plan stays
 * the anchor. The fix on such a host is to move the dynamic range, not to widen the hole.
 *
 * The range is part of the plan: it is the complement of the blocked ranges, so a host whose
 * range changes gets a different plan digest and provisions again, as for a DNS or PAC change.
 */
import { z } from "zod";
import { EGRESS_LOOPBACK_ENDPOINT_FACTS } from "./egress-policy-vocabulary.js";

/** The Windows default dynamic range. A default for tests and docs, never what a plan uses. */
export const EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_DEFAULT = { first: 49152, last: 65535 } as const;

/** Windows' own limits on a configurable dynamic range: it starts above 1024 and holds at least 255 ports. */
export const EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_BOUNDS = {
  min_first: 1025,
  max_last: 65535,
  min_count: 255,
} as const;

/** Why a host's dynamic range cannot be the gap; each is a typed reason to skip enforcement. */
export const EGRESS_LOOPBACK_DYNAMIC_RANGE_REFUSALS = [
  "loopback_dynamic_range_unavailable",
  "loopback_dynamic_range_invalid",
  "loopback_dynamic_range_covers_control_port",
] as const;
export type EgressLoopbackDynamicRangeRefusal =
  (typeof EGRESS_LOOPBACK_DYNAMIC_RANGE_REFUSALS)[number];

export interface EgressLoopbackDynamicRange {
  readonly first: number;
  readonly last: number;
}

/** Every port a declared loopback endpoint may listen on: the ports a gap must never contain. */
export function egressLoopbackBlockedPorts(): number[] {
  return Object.values(EGRESS_LOOPBACK_ENDPOINT_FACTS).flatMap((facts) => [...facts.ports]);
}

/**
 * Why `range` cannot be the gap, or `null` when it can. `undefined` or `null` is a range nobody
 * could read. Checked in this order: unreadable, not sane, covers a port the plan keeps blocked.
 */
export function egressLoopbackDynamicRangeRefusal(
  range: EgressLoopbackDynamicRange | null | undefined,
  blockedPorts: readonly number[] = egressLoopbackBlockedPorts()
): EgressLoopbackDynamicRangeRefusal | null {
  if (range === null || range === undefined) return "loopback_dynamic_range_unavailable";
  const { first, last } = range;
  const bounds = EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_BOUNDS;
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < bounds.min_first ||
    last > bounds.max_last ||
    last - first + 1 < bounds.min_count
  ) {
    return "loopback_dynamic_range_invalid";
  }
  if (blockedPorts.some((port) => port >= first && port <= last)) {
    return "loopback_dynamic_range_covers_control_port";
  }
  return null;
}

/**
 * The open range as an isolation report states it. Bounds are Windows' own, and `first <= last`
 * is the whole shape rule; whether a host range may be the gap at all is
 * `egressLoopbackDynamicRangeRefusal`, applied where the plan is made, not re-judged here.
 */
export const EgressLoopbackOpenTcpRangeSchema = z
  .object({
    first: z
      .number()
      .int()
      .min(EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_BOUNDS.min_first)
      .max(EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_BOUNDS.max_last),
    last: z
      .number()
      .int()
      .min(EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_BOUNDS.min_first)
      .max(EGRESS_LOOPBACK_DYNAMIC_PORT_RANGE_BOUNDS.max_last),
  })
  .strict()
  .refine((range) => range.first <= range.last, { message: "first must not exceed last" });
export type EgressLoopbackOpenTcpRange = z.infer<typeof EgressLoopbackOpenTcpRangeSchema>;
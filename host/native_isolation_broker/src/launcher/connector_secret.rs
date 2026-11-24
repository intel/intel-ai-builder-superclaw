//! Authenticated Connector client configuration, separate from lifecycle reports.

use super::pipe::TierPipeServer;
use super::pipe_acl::PipeRole;
use crate::frame::{FrameError, mac_hex, validate_nonce, verify_mac_hex};
use crate::launch_spec::ConnectorClientPayload;
use serde::{Deserialize, Serialize};
use std::io;
use std::time::Instant;

const VERSION: u32 = 1;
const DOMAIN: &[u8] = b"superclaw.connector-client-config.v1\0";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    nonce: String,
    payload: String,
    mac: String,
}

fn authenticated(nonce: &str, payload: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(DOMAIN.len() + nonce.len() + payload.len() + 8);
    bytes.extend_from_slice(DOMAIN);
    bytes.extend_from_slice(&(nonce.len() as u32).to_le_bytes());
    bytes.extend_from_slice(nonce.as_bytes());
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(payload.as_bytes());
    bytes
}

pub(super) fn seal(payload: &[u8], nonce: String, key: &[u8]) -> Result<Vec<u8>, FrameError> {
    validate_nonce(&nonce)?;
    let payload = std::str::from_utf8(payload).map_err(|_| FrameError::InvalidField)?;
    let mac = mac_hex(&authenticated(&nonce, payload), key)?;
    serde_json::to_vec(&Envelope {
        version: VERSION,
        nonce,
        payload: payload.to_owned(),
        mac,
    })
    .map_err(|_| FrameError::InvalidJson)
}

pub(super) fn open(body: &[u8], key: &[u8]) -> Result<ConnectorClientPayload, FrameError> {
    let envelope: Envelope = serde_json::from_slice(body).map_err(|_| FrameError::InvalidJson)?;
    if envelope.version != VERSION {
        return Err(FrameError::UnsupportedVersion);
    }
    validate_nonce(&envelope.nonce)?;
    verify_mac_hex(
        &authenticated(&envelope.nonce, &envelope.payload),
        &envelope.mac,
        key,
    )?;
    ConnectorClientPayload::from_json(envelope.payload.as_bytes())
        .map_err(|_| FrameError::InvalidField)
}

pub(super) fn io_error(error: FrameError) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("Connector secret envelope was refused: {}", error.code()),
    )
}

pub(super) fn create_server(
    enabled: bool,
    pipe_id: &str,
    owner_sid: &str,
    runner_sid: &str,
) -> io::Result<Option<TierPipeServer>> {
    enabled
        .then(|| TierPipeServer::create(pipe_id, PipeRole::ConnectorSecret, owner_sid, runner_sid))
        .transpose()
}

/// `bind` binds the connection to the runner the same way its control and report connections were.
pub(super) fn receive_from_runner(
    server: &TierPipeServer,
    bind: impl FnOnce(&TierPipeServer) -> io::Result<()>,
    key: &[u8],
    connect_by: Instant,
    receive_by: Instant,
) -> io::Result<ConnectorClientPayload> {
    server.await_client(connect_by)?;
    bind(server)?;
    let body = server
        .receive_connector_secret(receive_by)?
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Connector secret pipe closed before client configuration",
            )
        })?;
    open(&body, key).map_err(io_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &[u8] = b"01234567890123456789012345678901";

    #[test]
    fn secret_envelope_is_domain_authenticated_and_tamper_evident() {
        let sealed = seal(b"{\"contract_version\":1}", "a".repeat(32), KEY).unwrap();
        assert_eq!(
            open(&sealed, KEY).unwrap().as_slice(),
            b"{\"contract_version\":1}"
        );
        let mut value: serde_json::Value = serde_json::from_slice(&sealed).unwrap();
        value["payload"] = serde_json::Value::String("{}".to_owned());
        let error =
            open(&serde_json::to_vec(&value).unwrap(), KEY).expect_err("tampering must be refused");
        assert_eq!(error, FrameError::InvalidMac);
    }
}

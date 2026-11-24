//! The Connector's bootstrap line: exactly the seven fields its contract governs, generated here.
//!
//! # Why this is not a placeholder
//!
//! The bootstrap carries two 32-byte symmetric keys. A wire field would mean the keys crossed the
//! caller's process, its request JSON and the launcher's command line before reaching the role, so they
//! are drawn here instead, from `BCryptGenRandom`, once per launch. The consequence is deliberate and is
//! the whole reason P6 claims no Connector IPC: nothing outside the launched role holds the other half
//! of these keys, so no authenticated request can be made yet. Handing the caller half back is P7's
//! authenticated service IPC, and it will need a channel that is at least as protected as the
//! credential store, not a report frame.
//!
//! # Why the shape is asserted rather than assumed
//!
//! The authoritative parser is `host/sandbox_manager/src/sandbox_manager/connector.py`: it compares the
//! field set for exact equality, matches each identifier against a bounded pattern, requires both keys
//! to base64-decode to exactly 32 bytes, and reads the whole request with one `readline`. Every one of
//! those is mirrored by a test below, because a bootstrap this side considers well-formed and that side
//! refuses is a role that starts and then exits, which is the failure mode hardest to read from a log.
//!
//! # What the wiping does and does not claim
//!
//! The serialized line is copied into a `StdinPayload`, whose storage is wiped on drop, and the
//! intermediate `String` is wiped here. Not claimed: that `serde_json`'s internal growth left no copy
//! behind - it may have, and a buffer that has already been handed back to the allocator cannot be
//! wiped by anyone. The property that matters is structural rather than cryptographic: the payload
//! reaches the role's standard input and nothing else. It never becomes an argument, an environment
//! value, a log line or a file.
//!
//! The two key strings carry their own wipe rather than being wiped at the end of the happy path, which
//! is why `SecretText` exists. A struct literal that fails partway - one `random_key_b64` succeeding and
//! the next `?` returning - drops the fields already evaluated without ever constructing the struct, so
//! a `Drop` on the struct would not see them and a wipe written after the last `?` would not run. Making
//! it a property of the value covers every exit, including the ones nobody enumerated.

use crate::launch_spec::{ConnectorClientPayload, StdinPayload};
use crate::random_bytes::{fill_random, random_hex};
use crate::zeroize::wipe;
use serde::{Serialize, Serializer};
use std::collections::BTreeMap;
use std::io;
use std::path::Path;

/// Random bytes behind `boot-<hex>`. Sixteen, so the hex half is 32 characters, matching the product's
/// own `boot-{token_hex(16)}` and staying inside the peer's 128-character identifier bound.
const BOOT_ID_BYTES: usize = 16;

/// Random bytes behind `caller_<hex>` and `response_<hex>`. Eight, because the peer's key-identifier
/// pattern is exactly sixteen lowercase alphanumerics and would refuse anything longer.
const KEY_ID_BYTES: usize = 8;

/// The key size the peer requires after base64 decoding.
const KEY_BYTES: usize = 32;

/// The bootstrap object, in the field order the peer's `required` set lists.
///
/// The order is cosmetic - the peer compares sets - but a fixed one makes the serialized line
/// reproducible, which is what lets a test assert the whole string rather than pick it apart.
#[derive(Serialize)]
struct ConnectorBootstrap<'a> {
    boot_id: &'a str,
    caller_key_id: &'a str,
    caller_key_b64: &'a SecretText,
    response_key_id: &'a str,
    response_key_b64: &'a SecretText,
    search_module: &'a str,
    /// Always empty in this build. The peer allows a subset of eight proxy variable names, and nothing
    /// in the broker has a proxy configuration to pass: inventing one would put a network egress
    /// setting in the launch path that no product surface asked for. It is serialized rather than
    /// omitted because the peer's field set is compared for equality, so an absent `proxy` is refused.
    proxy: &'a BTreeMap<String, String>,
}

#[derive(Serialize)]
struct ConnectorClientConfig<'a> {
    contract_version: u32,
    endpoint: &'a str,
    boot_id: &'a str,
    caller_key_id: &'a str,
    caller_key_b64: &'a SecretText,
    response_key_id: &'a str,
    response_key_b64: &'a SecretText,
}

pub struct ConnectorBootstrapBundle {
    pub role_stdin: StdinPayload,
    pub client_config: ConnectorClientPayload,
}

/// Generates one Connector bootstrap line for one launch.
///
/// `search_module` is the module the Connector loads its search provider from. It is composed by role
/// resolution from `payload_root`, so it is a derived path rather than a caller string; this function
/// requires only that it be Unicode, because the peer reads it as text.
#[cfg(test)]
pub(crate) fn connector_bootstrap_line(search_module: &Path) -> io::Result<StdinPayload> {
    Ok(
        connector_bootstrap_bundle(search_module, "http://127.0.0.1:47823/v1/connector")?
            .role_stdin,
    )
}

pub fn connector_bootstrap_bundle(
    search_module: &Path,
    endpoint: &str,
) -> io::Result<ConnectorBootstrapBundle> {
    let search_module = search_module
        .to_str()
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the Connector search module path must be Unicode",
            )
        })?
        .to_owned();

    let boot_id = format!("boot-{}", random_hex(BOOT_ID_BYTES)?);
    let caller_key_id = format!("caller_{}", random_hex(KEY_ID_BYTES)?);
    let caller_key_b64 = random_key_b64()?;
    let response_key_id = format!("response_{}", random_hex(KEY_ID_BYTES)?);
    let response_key_b64 = random_key_b64()?;
    let proxy = BTreeMap::new();
    let bootstrap = ConnectorBootstrap {
        boot_id: &boot_id,
        caller_key_id: &caller_key_id,
        caller_key_b64: &caller_key_b64,
        response_key_id: &response_key_id,
        response_key_b64: &response_key_b64,
        search_module: &search_module,
        proxy: &proxy,
    };
    let client = ConnectorClientConfig {
        // The Connector IPC version the endpoint speaks: the contract publishes one number for both.
        contract_version: 2,
        endpoint,
        boot_id: &boot_id,
        caller_key_id: &caller_key_id,
        caller_key_b64: &caller_key_b64,
        response_key_id: &response_key_id,
        response_key_b64: &response_key_b64,
    };

    // Serialized through `serde_json` rather than by hand for one reason: `search_module` is a Windows
    // path, so the value needs JSON string escaping, and a hand-rolled escaper is a worse thing to own
    // than a dependency the crate already has.
    let mut line = serde_json::to_string(&bootstrap).map_err(|error| {
        // The error text is `serde_json`'s own and describes a structural fault - it cannot contain a
        // field value, and this branch is unreachable for a struct of strings and a map.
        io::Error::other(format!(
            "the Connector bootstrap could not be serialized: {error}"
        ))
    })?;
    line.push('\n');

    let role_stdin = StdinPayload::single_line(line.as_bytes())?;
    wipe_text(&mut line);
    let mut client_json = serde_json::to_string(&client).map_err(|error| {
        io::Error::other(format!(
            "the Connector client config could not be serialized: {error}"
        ))
    })?;
    let client_config = ConnectorClientPayload::from_json(client_json.as_bytes())?;
    wipe_text(&mut client_json);
    Ok(ConnectorBootstrapBundle {
        role_stdin,
        client_config,
    })
}

/// A string that wipes itself however it goes out of scope.
///
/// Serializes as the bare string, so the bootstrap's JSON shape is unchanged: the peer sees a key, not a
/// wrapper. `Debug` is deliberately not derived - the only way this reaches a diagnostic is if someone
/// writes one.
struct SecretText(String);

impl Drop for SecretText {
    fn drop(&mut self) {
        wipe_text(&mut self.0);
    }
}

impl Serialize for SecretText {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

/// Thirty-two random bytes as padded standard base64, which is what `base64.b64decode(validate=True)`
/// on the other side accepts.
fn random_key_b64() -> io::Result<SecretText> {
    let mut key = [0u8; KEY_BYTES];
    fill_random(&mut key)?;
    let encoded = base64_standard(&key);
    wipe(&mut key);
    Ok(SecretText(encoded))
}

/// RFC 4648 standard base64 with padding.
///
/// Written out rather than taken from a crate because it is the only base64 in this component and the
/// launcher's dependency surface is itself part of what the two-hop design is reviewed on. Twelve lines
/// with a published test vector is a smaller thing to audit than another crate in an unelevated binary
/// that reads credentials.
fn base64_standard(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let mut packed = 0u32;
        for (index, byte) in chunk.iter().enumerate() {
            packed |= u32::from(*byte) << (16 - 8 * index);
        }
        for index in 0..4 {
            encoded.push(if index <= chunk.len() {
                char::from(ALPHABET[(packed >> (18 - 6 * index)) as usize & 0x3f])
            } else {
                '='
            });
        }
    }
    encoded
}

/// Overwrites a string's bytes in place.
///
/// Zero is a valid UTF-8 byte, so the buffer stays a well-formed `String` and the borrow rules are not
/// being circumvented for anything but the volatile store `wipe` performs.
fn wipe_text(value: &mut String) {
    // SAFETY: every byte written is NUL, which is valid UTF-8 on its own, so the invariant `String`
    // relies on still holds when the borrow ends.
    wipe(unsafe { value.as_mut_vec() });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const SEARCH_MODULE: &str =
        r"C:\ProgramData\SuperClaw\payload\1.2.3\config-source\tools\sc_tavily_search.py";

    fn bootstrap_object() -> serde_json::Map<String, Value> {
        let payload = connector_bootstrap_line(Path::new(SEARCH_MODULE)).expect("a bootstrap line");
        let bytes = payload.as_slice();
        assert_eq!(bytes.last(), Some(&b'\n'));
        match serde_json::from_slice(&bytes[..bytes.len() - 1]).expect("the line is JSON") {
            Value::Object(object) => object,
            other => panic!("a bootstrap is a JSON object, not {other}"),
        }
    }

    /// The peer compares the field set for exact equality, so this test states the set rather than
    /// checking a few members: an added field is as fatal as a missing one.
    #[test]
    fn the_bootstrap_carries_exactly_the_governed_fields() {
        let object = bootstrap_object();
        let mut names: Vec<&str> = object.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            [
                "boot_id",
                "caller_key_b64",
                "caller_key_id",
                "proxy",
                "response_key_b64",
                "response_key_id",
                "search_module",
            ]
        );
        assert_eq!(object["search_module"], Value::from(SEARCH_MODULE));
        assert_eq!(
            object["proxy"],
            Value::Object(serde_json::Map::new()),
            "an empty allowlisted proxy map, never an absent field"
        );
    }

    /// The peer's three patterns, re-stated here as byte checks. `connector.py` spells them as
    /// `_ID_RE = ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and
    /// `_KEY_ID_RE = ^(?:caller|response)_[a-z0-9]{16}$`.
    #[test]
    fn every_identifier_matches_the_pattern_the_peer_enforces() {
        let object = bootstrap_object();
        let text = |name: &str| object[name].as_str().expect("a string field").to_owned();

        let boot_id = text("boot_id");
        let hex = boot_id
            .strip_prefix("boot-")
            .expect("the product's boot prefix");
        assert_eq!(hex.len(), BOOT_ID_BYTES * 2);
        assert!(hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(boot_id.len() <= 128, "the peer bounds an identifier at 128");
        assert!(boot_id.as_bytes()[0].is_ascii_alphanumeric());

        for (name, prefix) in [
            ("caller_key_id", "caller_"),
            ("response_key_id", "response_"),
        ] {
            let id = text(name);
            let hex = id.strip_prefix(prefix).expect("the peer's key id prefix");
            assert_eq!(hex.len(), 16, "{name} must be exactly sixteen characters");
            assert!(
                hex.bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                "{name} must be lowercase alphanumeric"
            );
        }
    }

    /// Both keys decode to exactly 32 bytes, and they are not the same key.
    ///
    /// Decoded with a local decoder rather than by trusting the encoder, so an encoder that dropped a
    /// byte or padded wrongly fails here instead of at the peer.
    #[test]
    fn both_keys_are_thirty_two_distinct_random_bytes() {
        let object = bootstrap_object();
        let caller = decode_base64(object["caller_key_b64"].as_str().expect("a string"));
        let response = decode_base64(object["response_key_b64"].as_str().expect("a string"));
        assert_eq!(caller.len(), KEY_BYTES);
        assert_eq!(response.len(), KEY_BYTES);
        assert_ne!(
            caller, response,
            "the request and response directions must not share a key"
        );
        assert!(
            caller.iter().any(|byte| *byte != 0),
            "an all-zero key means the RNG was never read"
        );
    }

    #[test]
    fn client_config_shares_only_the_boot_and_keys_with_role_bootstrap() {
        let bundle = connector_bootstrap_bundle(
            Path::new(SEARCH_MODULE),
            "http://127.0.0.1:47823/v1/connector",
        )
        .expect("a same-source bundle");
        let role: Value = serde_json::from_slice(
            &bundle.role_stdin.as_slice()[..bundle.role_stdin.as_slice().len() - 1],
        )
        .expect("role bootstrap JSON");
        let client: Value =
            serde_json::from_slice(bundle.client_config.as_slice()).expect("client config JSON");
        for field in [
            "boot_id",
            "caller_key_id",
            "caller_key_b64",
            "response_key_id",
            "response_key_b64",
        ] {
            assert_eq!(role[field], client[field], "{field}");
        }
        assert_eq!(client["endpoint"], "http://127.0.0.1:47823/v1/connector");
        assert!(client.get("search_module").is_none());
        assert!(client.get("proxy").is_none());
    }

    /// The configuration says which Connector IPC version its endpoint speaks, the one number the contract
    /// publishes for it. Read from the generated schema rather than restated, so a contract bump this side
    /// misses fails here instead of at the Sandbox Manager's strict check of the same file.
    #[test]
    fn the_client_config_names_the_ipc_version_the_contract_publishes() {
        let schema = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../../shared/contracts/generated/json-schema/broker-connector-client-config.json",
        );
        let schema: Value =
            serde_json::from_slice(&std::fs::read(schema).expect("the generated schema"))
                .expect("JSON");
        let published = &schema["properties"]["contract_version"]["const"];
        assert!(
            published.is_u64(),
            "the schema pins one version: {published}"
        );
        let bundle = connector_bootstrap_bundle(
            Path::new(SEARCH_MODULE),
            "http://127.0.0.1:47823/v1/connector",
        )
        .expect("a same-source bundle");
        let client: Value =
            serde_json::from_slice(bundle.client_config.as_slice()).expect("client config JSON");
        assert_eq!(&client["contract_version"], published);
    }

    /// Two launches share nothing. Without this, a bootstrap generated once and reused would satisfy
    /// every other test in this file.
    #[test]
    fn two_launches_share_no_identifier_and_no_key() {
        let first = bootstrap_object();
        let second = bootstrap_object();
        for field in [
            "boot_id",
            "caller_key_id",
            "response_key_id",
            "caller_key_b64",
            "response_key_b64",
        ] {
            assert_ne!(
                first[field], second[field],
                "{field} repeated across launches"
            );
        }
    }

    /// The line is one line, and it is one the peer's bounded `readline` can take whole.
    #[test]
    fn the_line_is_one_bounded_line() {
        let payload = connector_bootstrap_line(Path::new(SEARCH_MODULE)).expect("a bootstrap line");
        let bytes = payload.as_slice();
        assert_eq!(
            bytes.iter().filter(|byte| **byte == b'\n').count(),
            1,
            "an interior newline would truncate the peer's request"
        );
        assert!(bytes.len() < 1024, "{} bytes", bytes.len());
    }

    /// Published RFC 4648 test vectors, plus the length the Connector's key size produces. A base64
    /// encoder tested only against its own output is an encoder tested against nothing.
    #[test]
    fn the_base64_encoder_matches_the_published_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64_standard(input.as_bytes()), expected, "{input:?}");
        }
        assert_eq!(base64_standard(&[0xffu8; 32]).len(), 44);
        assert_eq!(base64_standard(&[0u8; 32]), format!("{}=", "A".repeat(43)));
    }

    #[test]
    fn a_wiped_string_keeps_nothing_and_stays_valid() {
        let mut text = "caller-key-sentinel".to_owned();
        wipe_text(&mut text);
        assert!(text.bytes().all(|byte| byte == 0));
        assert_eq!(text.len(), "caller-key-sentinel".len());
    }

    /// Standard base64 with padding, for the assertions above only.
    fn decode_base64(text: &str) -> Vec<u8> {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let trimmed = text.trim_end_matches('=');
        let mut decoded = Vec::new();
        let mut packed = 0u32;
        let mut bits = 0u32;
        for byte in trimmed.bytes() {
            let index = ALPHABET
                .iter()
                .position(|candidate| *candidate == byte)
                .unwrap_or_else(|| panic!("{byte:?} is not a base64 character"));
            packed = (packed << 6) | index as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                decoded.push((packed >> bits) as u8);
            }
        }
        decoded
    }
}

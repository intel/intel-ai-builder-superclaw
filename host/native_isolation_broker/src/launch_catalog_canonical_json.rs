use serde_json::Value;

pub(super) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            let parts = items.iter().map(canonical_json).collect::<Vec<_>>();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            let parts = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("key"),
                        canonical_json(&map[*key])
                    )
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", parts.join(","))
        }
        _ => serde_json::to_string(value).expect("scalar"),
    }
}

#[cfg(test)]
mod tests {
    use super::canonical_json;
    use crate::broker_wire::canonical_wire_json;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;

    /// This crate canonicalizes in two places: here, for the catalog digest, and in
    /// `canonical_wire_json`, for a WFP plan's `providerData` tag, the ACL descriptor digest and the
    /// provision receipt. Every other language takes the same digests over the same bytes, so both forms
    /// must write each value exactly as the shared table does, non-ASCII text as itself included.
    #[test]
    fn both_canonical_forms_write_the_shared_cases_byte_for_byte() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../shared/contracts/test-fixtures/canonical-json-cases.json");
        let fixture: Value =
            serde_json::from_slice(&std::fs::read(path).expect("the shared table")).expect("JSON");
        let cases = fixture["cases"].as_array().expect("a cases array");
        assert!(!cases.is_empty(), "no case, so nothing is proved");
        for case in cases {
            let name = case["name"].as_str().expect("a case name");
            let expected = case["canonical_json"].as_str().expect("the canonical form");
            assert_eq!(canonical_json(&case["value"]), expected, "{name}: catalog");
            assert_eq!(
                canonical_wire_json(&case["value"]).expect("a canonical form"),
                expected,
                "{name}: wire"
            );
            assert_eq!(
                hex::encode(Sha256::digest(expected.as_bytes())),
                case["sha256"].as_str().expect("the digest"),
                "{name}: digest"
            );
        }
    }
}

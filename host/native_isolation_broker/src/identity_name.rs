//! Deterministic owner-by-tier naming, shared and pure.
//!
//! Nothing in this module touches Win32, the filesystem or broker state. That is the point: the
//! account name and the credential filename are a pure function of the owner SID and the tier, so a
//! caller that only needs to find one credential file never needs permission to enumerate the
//! protected identity directory or to read an identity record.
//!
//! The elevated broker and the unprivileged `native_isolation_launcher` both compile this module,
//! so there is no second copy of the hash. `scripts/native-isolation/broker-account-name.ps1`
//! reimplements `account_name_for` in PowerShell for the installer's post-revoke check and the
//! file_tool boundary test; the two must stay in step.
//!
//! The tier enum itself stays in `tier`, which is the module the launcher already links. This module
//! is the derivation only, so there is exactly one definition of a tier and exactly one definition of
//! the names it produces.

use crate::tier::IsolationTier;
use sha2::{Digest, Sha256};

/// Derives the SAM-compatible local account name for one owner and tier.
pub fn account_name_for(owner_sid: &str, tier: IsolationTier) -> String {
    let mut hasher = Sha256::new();
    hasher.update(owner_sid.as_bytes());
    hasher.update([0]);
    hasher.update(tier.as_str().as_bytes());
    let digest = hasher.finalize();
    format!("SCB{}{}", tier.account_code(), base32_80(&digest[..10]))
}

/// Filename of the DPAPI credential blob for `account_name` inside the identity state directory.
pub fn credential_file_name(account_name: &str) -> String {
    format!("credential-{account_name}.bin")
}

/// Filename of the authenticated identity record for `account_name`.
pub fn identity_record_file_name(account_name: &str) -> String {
    format!("identity-{account_name}.json")
}

fn base32_80(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut result = String::with_capacity(16);
    let mut accumulator = 0u32;
    let mut bits = 0;
    for byte in bytes {
        accumulator = (accumulator << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            result.push(ALPHABET[((accumulator >> bits) & 0x1f) as usize] as char);
        }
        accumulator &= if bits == 0 { 0 } else { (1 << bits) - 1 };
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one owner SID whose derived names are pinned as literals here and in both mirrors, so a
    /// change to the digest, the separator, the truncation or the alphabet is a test failure rather
    /// than a silent runtime mismatch. Keep in step with `GOLDEN_ACCOUNT_NAMES` in
    /// `host/sandbox_manager/tests/unit/test_broker_client.py` and the `Golden` values of
    /// `$script:BrokerTiers` in `scripts/native-isolation/broker-account-name.ps1`, which every
    /// caller self-checks on each run because the scripts have no test suite of their own.
    const GOLDEN_OWNER_SID: &str = "S-1-5-21-100-200-300-1001";

    #[test]
    fn account_names_match_the_golden_vector_shared_with_both_mirrors() {
        // Two other implementations of this function exist, in Python and in PowerShell, because an
        // unprivileged caller has to name a credential file without reading protected state. Property
        // assertions alone cannot catch them drifting apart: any of the three could change shape and
        // still produce 20 SAM-legal characters.
        assert_eq!(
            IsolationTier::ALL.map(|tier| account_name_for(GOLDEN_OWNER_SID, tier)),
            [
                "SCBBZUMXK5U6MIU7VEA4",
                "SCBFHEC353DKTS3MJ567",
                "SCBCYNW6JFA3JGNEZI6S",
                "SCBHFPHODFW2R7UVHRDE",
            ]
            .map(str::to_owned)
        );
    }

    /// `revoke_owner_state` derives one account name per `IsolationTier::ALL`, so the channel
    /// account is removed on revoke and uninstall exactly when it is in that set.
    #[test]
    fn the_names_revoke_derives_include_the_channel_account() {
        let revoked: Vec<_> = IsolationTier::ALL
            .into_iter()
            .map(|tier| account_name_for(GOLDEN_OWNER_SID, tier))
            .collect();
        assert!(revoked.contains(&"SCBHFPHODFW2R7UVHRDE".to_owned()));
        assert!(revoked.iter().filter(|name| name.starts_with("SCBH")).count() == 1);
    }

    #[test]
    fn account_names_are_stable_unique_and_sam_compatible() {
        let owner = GOLDEN_OWNER_SID;
        let names: Vec<_> = IsolationTier::ALL
            .into_iter()
            .map(|tier| account_name_for(owner, tier))
            .collect();
        assert_eq!(names[0], account_name_for(owner, IsolationTier::Bootstrap));
        assert!(names.iter().all(|name| name.len() == 20));
        assert!(names.iter().all(|name| {
            name.bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        }));
        assert_ne!(names[0], names[1]);
        assert_ne!(names[1], names[2]);
        assert_ne!(
            names[0],
            account_name_for("S-1-5-21-100-200-300-1002", IsolationTier::Bootstrap)
        );
    }

    #[test]
    fn state_filenames_are_derived_only_from_the_account_name() {
        let owner = "S-1-5-21-100-200-300-1001";
        let account = account_name_for(owner, IsolationTier::FileTool);
        assert_eq!(
            credential_file_name(&account),
            format!("credential-{account}.bin")
        );
        assert_eq!(
            identity_record_file_name(&account),
            format!("identity-{account}.json")
        );
        assert_ne!(
            credential_file_name(&account),
            credential_file_name(&account_name_for(owner, IsolationTier::Bootstrap))
        );
    }
}

use crate::acl_windows::{read_broker_file, write_broker_file};
use crate::credential_store::{read_credential_converging, write_credential};
use crate::secrets;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::io;
use std::path::Path;

const IDENTITY_RECORD_VERSION: u32 = 1;
const MAX_IDENTITY_RECORD_SIZE: usize = 16 * 1024;
type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityRecord {
    pub version: u32,
    pub owner_sid: String,
    pub tier: String,
    pub account_name: String,
    pub account_sid: String,
    pub revision: u64,
    pub mac: String,
}

#[derive(Serialize)]
struct AuthenticatedIdentityRecord<'a> {
    version: u32,
    owner_sid: &'a str,
    tier: &'a str,
    account_name: &'a str,
    account_sid: &'a str,
    revision: u64,
}

pub fn new_identity_record(
    owner_sid: String,
    tier: String,
    account_name: String,
    account_sid: String,
    revision: u64,
    credential: &[u8],
) -> io::Result<IdentityRecord> {
    let mut record = IdentityRecord {
        version: IDENTITY_RECORD_VERSION,
        owner_sid,
        tier,
        account_name,
        account_sid,
        revision,
        mac: String::new(),
    };
    record.mac = compute_record_mac(&record, credential)?;
    Ok(record)
}

pub fn verify_identity_record(record: &IdentityRecord, credential: &[u8]) -> io::Result<()> {
    if record.version != IDENTITY_RECORD_VERSION || record.revision == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "identity record version or revision is invalid",
        ));
    }
    let supplied = hex::decode(&record.mac).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidData, "identity record MAC is invalid")
    })?;
    let authenticated = authenticated_record_bytes(record)?;
    let mut mac = HmacSha256::new_from_slice(credential).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidData, "identity record key is invalid")
    })?;
    mac.update(&authenticated);
    mac.verify_slice(&supplied).map_err(|_| {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "identity record authentication failed",
        )
    })
}

pub fn credential_exists(state_dir: &Path, filename: &str) -> bool {
    state_dir.join(filename).is_file()
}

/// Stores a tier password under the credential-specific `SY + BA + owner read` descriptor.
///
/// Credentials never go through `write_broker_file`: that function only knows the narrower broker
/// state descriptor, and a credential written under it would be unreadable by the unprivileged
/// launcher.
pub fn save_password(
    state_dir: &Path,
    filename: &str,
    owner_sid: &str,
    password: &str,
) -> io::Result<()> {
    let encrypted = secrets::protect(password.as_bytes())?;
    write_credential(&state_dir.join(filename), owner_sid, &encrypted)
}

/// Reads and decrypts a tier password, from the elevated broker.
///
/// Every descriptor, object-type and size check happens inside `read_credential_converging`, before
/// the blob reaches DPAPI: machine-scoped `CRYPTPROTECT_LOCAL_MACHINE` means the file descriptor is
/// the confidentiality boundary, so an unverified blob must never be unprotected.
///
/// The converging variant is used rather than the plain read because a credential written before P3
/// carries the broker-wide `SY + BA` descriptor, which the read refuses as drift, and only this
/// elevated process holds the `WRITE_DAC` that converges it. The convergence has to live here rather
/// than in one caller: provision, ACL apply and launch all observe an identity by reading its
/// credential through this function, so putting it in any single one of them would leave the others
/// refusing an upgraded install outright. On an already-converged blob it costs nothing beyond the
/// descriptor comparison the read performs anyway.
pub fn load_password(state_dir: &Path, filename: &str, owner_sid: &str) -> io::Result<String> {
    let (encrypted, _) = read_credential_converging(&state_dir.join(filename), owner_sid)?;
    let decrypted = secrets::unprotect(&encrypted)?;
    String::from_utf8(decrypted).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "stored credential is not valid UTF-8",
        )
    })
}

pub fn save_identity_record(
    state_dir: &Path,
    filename: &str,
    record: &IdentityRecord,
) -> io::Result<()> {
    let payload = serde_json::to_vec(record)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_protected(state_dir, filename, &payload)
}

pub fn load_identity_record(
    state_dir: &Path,
    filename: &str,
    credential: &[u8],
) -> io::Result<IdentityRecord> {
    let payload = read_broker_file(&state_dir.join(filename), MAX_IDENTITY_RECORD_SIZE)?;
    let record: IdentityRecord = serde_json::from_slice(&payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    verify_identity_record(&record, credential)?;
    Ok(record)
}

pub fn remove_identity_state(
    state_dir: &Path,
    credential_filename: &str,
    record_filename: &str,
) -> io::Result<()> {
    remove_if_present(&state_dir.join(record_filename))?;
    remove_if_present(&state_dir.join(credential_filename))
}

/// Re-exported so every caller keeps naming state layout through `state`, while the definitions
/// themselves live in a module the unelevated launcher can declare: P4's launcher needs the identity
/// directory to derive a credential path, and this module reaches `acl_windows` and
/// `credential_store`.
pub use crate::state_paths::{default_state_dir, isolation_data_dir, program_data_dir};

fn write_protected(state_dir: &Path, filename: &str, payload: &[u8]) -> io::Result<()> {
    write_broker_file(&state_dir.join(filename), payload)
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn compute_record_mac(record: &IdentityRecord, credential: &[u8]) -> io::Result<String> {
    let authenticated = authenticated_record_bytes(record)?;
    let mut mac = HmacSha256::new_from_slice(credential).map_err(|_| {
        io::Error::new(io::ErrorKind::InvalidData, "identity record key is invalid")
    })?;
    mac.update(&authenticated);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn authenticated_record_bytes(record: &IdentityRecord) -> io::Result<Vec<u8>> {
    serde_json::to_vec(&AuthenticatedIdentityRecord {
        version: record.version,
        owner_sid: &record.owner_sid,
        tier: &record.tier,
        account_name: &record.account_name,
        account_sid: &record.account_sid,
        revision: record.revision,
    })
    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential_read::read_credential_for_owner;
    use crate::security_descriptor::unique_temp_path;
    use crate::sid_win32::current_process_sid;

    /// The protected state root must not move when the caller's environment says it should.
    ///
    /// This is the property the elevated broker depends on and the reason the environment read was
    /// replaced. `ShellExecuteExW` gives an elevated child the launching process's environment block, so
    /// if `%PROGRAMDATA%` decided where the isolation root was, an unprivileged owner could point the
    /// broker's own state - and the two managed roots the owner is not supposed to be able to reach -
    /// wherever it liked. The test mutates the variable in this process and requires the answer not to
    /// follow it.
    ///
    /// It restores the previous value on the way out, because a leaked `PROGRAMDATA` would follow every
    /// other test in this process.
    #[test]
    fn the_protected_state_root_does_not_follow_the_environment() {
        let honest = program_data_dir().expect("the machine has a common application data folder");
        assert!(
            honest.is_absolute(),
            "the resolved folder must be an absolute path, got {honest:?}"
        );

        let previous = std::env::var_os("PROGRAMDATA");
        // SAFETY: single-variable mutation restored below; no other thread in this test reads it.
        unsafe { std::env::set_var("PROGRAMDATA", "C:\\SuperClawNotProgramData") };
        let under_a_lie = program_data_dir();
        match previous {
            Some(value) => unsafe { std::env::set_var("PROGRAMDATA", value) },
            None => unsafe { std::env::remove_var("PROGRAMDATA") },
        }

        assert_eq!(
            under_a_lie.expect("the folder still resolves"),
            honest,
            "the common application data folder must come from the machine, not from the caller"
        );
    }

    #[test]
    fn the_elevated_read_path_converges_a_credential_descriptor_before_reading() {
        // The upgrade case, at the level that actually broke. Every elevated entry point observes an
        // identity by reading its credential through `load_password`, so if the convergence does not
        // happen inside this function, an install whose credentials predate P3 refuses provision, ACL
        // apply and launch alike, and re-running provision never repairs it.
        //
        // The seeded blob carries the inherited, unprotected descriptor any file gets when the broker
        // did not create it with its own, which is one of the shapes `read_credential_for_owner`
        // refuses. Which refused shape it is does not matter to the property under test, and this one
        // is reachable without an administrator token: converging the true pre-P3 `SY + BA`
        // descriptor needs the `WRITE_DAC` only the elevated broker holds, covered by
        // `credential_store`'s legacy test and by the elevated acceptance.
        let state_dir = unique_temp_path("legacy-credential-state");
        std::fs::create_dir(&state_dir).unwrap();
        let filename = "credential-SCBTESTLEGACY.bin";
        let owner = current_process_sid().unwrap();
        std::fs::write(
            state_dir.join(filename),
            secrets::protect(b"legacy-tier-password").unwrap(),
        )
        .unwrap();

        // Without the convergence inside `load_password`, this refusal is what every caller would
        // get.
        assert!(read_credential_for_owner(&state_dir.join(filename), &owner).is_err());
        assert_eq!(
            load_password(&state_dir, filename, &owner).unwrap(),
            "legacy-tier-password"
        );

        std::fs::remove_file(state_dir.join(filename)).unwrap();
        std::fs::remove_dir(&state_dir).unwrap();
    }

    #[test]
    fn revoke_removes_both_the_credential_and_the_identity_record() {
        let state_dir = unique_temp_path("revoke-state");
        std::fs::create_dir(&state_dir).unwrap();
        let credential = "credential-SCBTESTACCOUNT.bin";
        let record = "identity-SCBTESTACCOUNT.json";
        std::fs::write(state_dir.join(credential), b"blob").unwrap();
        std::fs::write(state_dir.join(record), b"{}").unwrap();

        remove_identity_state(&state_dir, credential, record).unwrap();
        assert!(!state_dir.join(credential).exists());
        assert!(!state_dir.join(record).exists());

        // Revoke is idempotent: a second pass on already-absent state must not fail, because the
        // installer cleanup path and provision rollback both call it unconditionally.
        remove_identity_state(&state_dir, credential, record).unwrap();

        std::fs::remove_dir(&state_dir).unwrap();
    }

    #[test]
    fn owner_record_authentication_binds_every_identity_field() {
        let credential = b"tier-credential";
        let record = new_identity_record(
            "S-1-5-21-1-2-3-1001".to_owned(),
            "file_tool".to_owned(),
            "SCF0123456789AB".to_owned(),
            "S-1-5-21-4-5-6-1002".to_owned(),
            1,
            credential,
        )
        .unwrap();
        verify_identity_record(&record, credential).unwrap();

        let mutations: [fn(&mut IdentityRecord); 5] = [
            |value| value.owner_sid.push('9'),
            |value| value.tier.push('x'),
            |value| value.account_name.push('x'),
            |value| value.account_sid.push('9'),
            |value| value.revision += 1,
        ];
        for mutate in mutations {
            let mut tampered = record.clone();
            mutate(&mut tampered);
            assert_eq!(
                verify_identity_record(&tampered, credential)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
        }
    }
}

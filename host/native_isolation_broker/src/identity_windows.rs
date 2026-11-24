use crate::account_rights_windows;
use crate::dcom_restriction_windows;
use crate::identity_name::{account_name_for, credential_file_name, identity_record_file_name};
use crate::profile_env::initialize_profile;
use crate::random;
use crate::sid_win32::{LocalAllocation, canonical_owner_sid, canonical_sid, lookup_account_sid};
use crate::state::{self, IdentityRecord};
pub use crate::tier::IsolationTier;
use crate::tier_profile::remove_orphaned_profiles;
use crate::wide::to_wide;
use std::io;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, GetLastError};
use windows_sys::Win32::NetworkManagement::NetManagement::{
    NERR_UserNotFound, NetApiBufferFree, NetUserAdd, NetUserDel, NetUserGetInfo,
    UF_DONT_EXPIRE_PASSWD, UF_NORMAL_ACCOUNT, UF_SCRIPT, USER_INFO_1, USER_PRIV_USER,
};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::{
    LookupAccountSidW, PSID, SID_NAME_USE, SidTypeAlias, SidTypeComputer, SidTypeDeletedAccount,
    SidTypeDomain, SidTypeGroup, SidTypeLabel, SidTypeLogonSession, SidTypeUser,
    SidTypeWellKnownGroup,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvisionedIdentity {
    pub owner_sid: String,
    pub tier: IsolationTier,
    pub account_name: String,
    pub account_sid: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityStatus {
    Absent,
    Provisioned(ProvisionedIdentity),
}

pub struct WindowsTierIdentity {
    owner_sid: String,
    tier: IsolationTier,
    account_name: String,
    state_dir: PathBuf,
}

impl WindowsTierIdentity {
    pub fn new(owner_sid: &str, tier: IsolationTier, state_dir: PathBuf) -> io::Result<Self> {
        // One gate for both derived values: the account name this owner gets and the credential ACE
        // it gets are computed from the same canonical account SID, so a SID that cannot be an owner
        // is refused before either exists.
        let owner_sid = canonical_owner_sid(owner_sid)?;
        let account_name = account_name_for(&owner_sid, tier);
        Ok(Self {
            owner_sid,
            tier,
            account_name,
            state_dir,
        })
    }

    pub fn status(&self) -> io::Result<IdentityStatus> {
        Ok(match self.observe()? {
            None => IdentityStatus::Absent,
            Some((identity, _)) => IdentityStatus::Provisioned(identity),
        })
    }

    /// One authenticated observation of this identity: the account, the record, and the tier password
    /// the record was verified with.
    ///
    /// Asking whether an identity is provisioned and asking for its password are the same read, so
    /// both callers share it. As two entry points they made a launch verify the identity and then
    /// read, verify and DPAPI-unprotect the same credential a second time to obtain the password -
    /// two of every check on a path that runs on every launch and every ACL apply.
    fn observe(&self) -> io::Result<Option<(ProvisionedIdentity, String)>> {
        let account_sid = self.account_sid()?;
        let credential_present = state::credential_exists(&self.state_dir, &self.credential_file());
        let record_present = self.record_path().is_file();
        match classify_presence(account_sid, credential_present, record_present)? {
            None => Ok(None),
            Some(account_sid) => {
                let password = self.load_credential()?;
                let record = state::load_identity_record(
                    &self.state_dir,
                    &self.record_file(),
                    password.as_bytes(),
                )?;
                self.verify_record(&record, &account_sid)?;
                Ok(Some((
                    ProvisionedIdentity {
                        owner_sid: self.owner_sid.clone(),
                        tier: self.tier,
                        account_name: self.account_name.clone(),
                        account_sid,
                        revision: record.revision,
                    },
                    password,
                )))
            }
        }
    }

    pub fn ensure_provisioned(&self) -> io::Result<ProvisionedIdentity> {
        // An already-provisioned credential may still carry the previous `SY + BA` descriptor. The
        // convergence is not done here: `status()` reads the credential through
        // `state::load_password`, whose read converges the descriptor on the same handle it reads
        // from, so every elevated observation of an identity converges. Doing it here instead would
        // only fix provision and leave ACL apply and launch refusing an upgraded install.
        if let IdentityStatus::Provisioned(identity) = self.status()? {
            // issue #3011 convergence: an account provisioned before the minimum logon rights
            // existed has to get them on the next provision. Applying is idempotent - LSA stores
            // rights as a set - and `apply_minimum_logon_rights` reads the account's rights back
            // before it returns, so this is also where a drift is caught on an upgraded install.
            account_rights_windows::apply_minimum_logon_rights(&identity.account_sid)?;
            dcom_restriction_windows::apply_tier_dcom_deny(&identity.account_sid)?;
            return Ok(identity);
        }

        let password = random::generate_password()?;
        self.create_account(&password)?;
        match self.finish_provision(&password) {
            Ok(identity) => Ok(identity),
            Err(error) => {
                // Both machine-wide effects are keyed by the account SID, so remove them while the
                // account still exists; a later revoke could not recover the SID from a deleted
                // account. Each removal treats absence as success, so this is a no-op when the failure
                // happened before the effect was written.
                let machine_rollback = (|| -> io::Result<()> {
                    if let Some(sid) = self.account_sid()? {
                        dcom_restriction_windows::remove_tier_dcom_deny(&sid)?;
                        account_rights_windows::remove_minimum_logon_rights(&sid)?;
                    }
                    Ok(())
                })();
                // The DCOM deny and the deny rights are keyed by the account SID, so they can only be
                // removed while the account still exists. If that removal failed, keep the account and
                // its state: deleting the account would strand the ACE and the rights with no SID left to
                // find them, which is what `revoke_tier_state` avoids. A later revoke retries both.
                if !rollback_deletes_account(&machine_rollback) {
                    let rollback_error = machine_rollback.unwrap_err();
                    return Err(io::Error::other(format!(
                        "identity provision failed ({error}); the machine-wide policy could not be \
                         rolled back ({rollback_error}), so the account and its state were kept for a \
                         later revoke to retry"
                    )));
                }
                let account_rollback = delete_account(&self.account_name);
                let state_rollback = state::remove_identity_state(
                    &self.state_dir,
                    &self.credential_file(),
                    &self.record_file(),
                );
                if let Err(rollback_error) = account_rollback.and(state_rollback) {
                    return Err(io::Error::other(format!(
                        "identity provision failed ({error}); rollback also failed ({rollback_error})"
                    )));
                }
                Err(error)
            }
        }
    }

    /// Reads the tier password. `state::load_password` converges a pre-P3 credential descriptor on
    /// the handle it reads from, so this is also the repair path for an upgraded install.
    fn load_credential(&self) -> io::Result<String> {
        state::load_password(&self.state_dir, &self.credential_file(), &self.owner_sid)
    }

    /// Removes this one identity. Used by provision rollback, which already holds the identity it
    /// created; `revoke_owner_state` is the entry point for revoking an owner outright.
    pub fn revoke(&self) -> io::Result<()> {
        revoke_tier_state(&self.account_name, &self.state_dir)
    }

    fn finish_provision(&self, password: &str) -> io::Result<ProvisionedIdentity> {
        // Load-bearing although no launch loads it: the launcher strips `USERPROFILE`, so a role with
        // no declared home resolves Bun's `os.homedir()` through this profile's directory, and
        // openwork-server and opencode-router exit at startup with `ENOMEM: uv_os_homedir` without it.
        initialize_profile(&self.account_name, password)?;
        state::save_password(
            &self.state_dir,
            &self.credential_file(),
            &self.owner_sid,
            password,
        )?;
        let account_sid = self.account_sid()?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "new owner-by-tier account disappeared during provision",
            )
        })?;
        // issue #3011: an account with the default logon rights lets Task Scheduler, WMI,
        // out-of-process COM and BITS start code outside the role Job. Remove the rights those
        // services need, before the identity is recorded. The account already exists, so a failure
        // here is rolled back by `ensure_provisioned`, which deletes it.
        account_rights_windows::apply_minimum_logon_rights(&account_sid)?;
        // issue #3011: an out-of-proc COM activation starts its server outside the role Job. Merge the
        // machine-wide DCOM deny for this SID so the tier cannot launch one.
        dcom_restriction_windows::apply_tier_dcom_deny(&account_sid)?;
        let record = state::new_identity_record(
            self.owner_sid.clone(),
            self.tier.as_str().to_owned(),
            self.account_name.clone(),
            account_sid.clone(),
            1,
            password.as_bytes(),
        )?;
        state::save_identity_record(&self.state_dir, &self.record_file(), &record)?;
        Ok(ProvisionedIdentity {
            owner_sid: self.owner_sid.clone(),
            tier: self.tier,
            account_name: self.account_name.clone(),
            account_sid,
            revision: record.revision,
        })
    }

    fn verify_record(&self, record: &IdentityRecord, account_sid: &str) -> io::Result<()> {
        if record.owner_sid != self.owner_sid
            || record.tier != self.tier.as_str()
            || record.account_name != self.account_name
            || record.account_sid != account_sid
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "identity record does not match the requested owner and tier",
            ));
        }
        Ok(())
    }

    fn account_sid(&self) -> io::Result<Option<String>> {
        let name = to_wide(&self.account_name);
        let mut info: *mut u8 = std::ptr::null_mut();
        // SAFETY: name is NUL-terminated and info is a writable NetAPI out-pointer.
        let status = unsafe { NetUserGetInfo(std::ptr::null(), name.as_ptr(), 0, &mut info) };
        if status == NERR_UserNotFound {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        // SAFETY: NetUserGetInfo allocated info and NetApiBufferFree is its documented release.
        unsafe {
            NetApiBufferFree(info.cast());
        }
        // The elevated broker records whatever SID its own `NetUserAdd` produced for a name it has
        // just confirmed with `NetUserGetInfo`, so the account type needs no second opinion here. The
        // launcher, which resolves a name it did not create, uses the validating wrapper instead.
        lookup_account_sid(&self.account_name).map(|(sid, _)| Some(sid))
    }

    fn create_account(&self, password: &str) -> io::Result<()> {
        let mut name = to_wide(&self.account_name);
        let mut password = to_wide(password);
        let user_info = USER_INFO_1 {
            usri1_name: name.as_mut_ptr(),
            usri1_password: password.as_mut_ptr(),
            usri1_password_age: 0,
            usri1_priv: USER_PRIV_USER,
            usri1_home_dir: std::ptr::null_mut(),
            usri1_comment: std::ptr::null_mut(),
            usri1_flags: UF_SCRIPT | UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD,
            usri1_script_path: std::ptr::null_mut(),
        };
        let mut parameter_error = 0;
        // SAFETY: all pointers in user_info remain valid through the call.
        let status = unsafe {
            NetUserAdd(
                std::ptr::null(),
                1,
                (&raw const user_info).cast(),
                &mut parameter_error,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        Ok(())
    }

    fn credential_file(&self) -> String {
        credential_file_name(&self.account_name)
    }

    fn record_file(&self) -> String {
        identity_record_file_name(&self.account_name)
    }

    fn record_path(&self) -> PathBuf {
        self.state_dir.join(self.record_file())
    }
}

/// Requires that this machine resolves an owner SID to a user account.
///
/// The resolution-dependent half of the owner gate, kept out of `canonical_owner_sid` because it
/// cannot run on a hot path: `LookupAccountSidW` may contact a domain controller, and
/// `canonical_owner_sid` runs on every credential descriptor build.
///
/// What it closes is the residue of the structural check. A local or domain *group* SID also lives
/// under `S-1-5-21-`, and as a credential owner it would grant `FILE_GENERIC_READ` on every tier
/// password to every member of the group: the same over-grant the well-known-SID refusal exists to
/// prevent, reached by a different route.
///
/// # Where this runs, and why it is fail-closed
///
/// Every point that *writes* an owner ACE calls this first, and nothing else does: provision ingress,
/// `write_credential`, and the one branch of `read_credential_converging` that widens a drifted
/// descriptor. A read that finds the descriptor already correct never calls it, which is what keeps
/// the lookup off the hot path and keeps steady-state launch working with no name resolution at all.
///
/// Because the callers are exactly the granting ones, an unresolvable SID is refused rather than
/// accepted. A SID this machine maps to no account may still be a domain group whose controller is
/// unreachable, and admitting it would put that group in every credential ACE, so the earlier
/// fail-open reading of "not known to be wrong" was the wrong default for a grant. The cost is
/// bounded and visible: provisioning an owner whose SID cannot be resolved now fails with a message
/// saying so and can be retried, instead of silently widening every tier password to a group.
pub fn verify_owner_sid_names_a_user(value: &str) -> io::Result<()> {
    let canonical = canonical_owner_sid(value)?;
    match resolved_sid_use(&canonical)? {
        Some(sid_use) if OWNER_SID_USES.contains(&sid_use) => Ok(()),
        Some(other) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "owner SID must name a user account, but {canonical} resolves to {}",
                sid_use_label(other)
            ),
        )),
        None => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "owner SID {canonical} resolves to no account on this machine, so it cannot be \
                 confirmed to name a user rather than a group; retry when the account is resolvable"
            ),
        )),
    }
}

/// The account types an owner SID may have. A deleted account is allowed because this machine still
/// answers that the SID was an account rather than a group, which is the fact being checked.
const OWNER_SID_USES: [SID_NAME_USE; 2] = [SidTypeUser, SidTypeDeletedAccount];

/// The account type this machine gives a SID, or `None` when it maps to no account at all.
fn resolved_sid_use(value: &str) -> io::Result<Option<SID_NAME_USE>> {
    let wide = to_wide(value);
    let mut sid: PSID = std::ptr::null_mut();
    // SAFETY: Input is NUL-terminated and output receives LocalAlloc memory.
    if unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) } == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "owner SID is not valid",
        ));
    }
    let sid = LocalAllocation::new(sid)?;
    let mut name_length = 0;
    let mut domain_length = 0;
    let mut sid_use: SID_NAME_USE = 0;
    // SAFETY: sizing call; sid is valid and all out-parameters are writable.
    unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            sid.pointer(),
            std::ptr::null_mut(),
            &mut name_length,
            std::ptr::null_mut(),
            &mut domain_length,
            &mut sid_use,
        );
    }
    if name_length == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Ok(None);
    }
    let mut name = vec![0u16; name_length as usize];
    let mut domain = vec![0u16; domain_length.max(1) as usize];
    // SAFETY: both buffers were sized by the preceding call.
    if unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            sid.pointer(),
            name.as_mut_ptr(),
            &mut name_length,
            domain.as_mut_ptr(),
            &mut domain_length,
            &mut sid_use,
        )
    } == 0
    {
        return Ok(None);
    }
    Ok(Some(sid_use))
}

/// Names the refused SID types, so a refusal says what the SID actually is. A table rather than a
/// `match`, because the `windows_sys` `SidType*` constants are not upper case and using them as
/// match patterns trips `non_upper_case_globals`.
const SID_USE_LABELS: [(SID_NAME_USE, &str); 7] = [
    (SidTypeGroup, "a group"),
    (SidTypeAlias, "an alias (local group)"),
    (SidTypeWellKnownGroup, "a well-known group"),
    (SidTypeDomain, "a domain"),
    (SidTypeComputer, "a computer account"),
    (SidTypeLabel, "an integrity label"),
    (SidTypeLogonSession, "a logon session"),
];

fn sid_use_label(sid_use: SID_NAME_USE) -> &'static str {
    SID_USE_LABELS
        .iter()
        .find(|(value, _)| *value == sid_use)
        .map_or("neither a user nor a deleted account", |(_, label)| label)
}

/// Deletes every owner-by-tier account and every piece of protected state belonging to `owner_sid`.
///
/// Removal deliberately applies a wider owner rule than the granting paths do. `canonical_owner_sid`
/// refuses any SID outside the account prefixes, and `verify_owner_sid_names_a_user` refuses a SID
/// this machine will not vouch for as a user; both are right for a path about to write an owner ACE,
/// and both are wrong for the path whose entire job is to take one away. State provisioned before
/// those gates existed - under an SDDL alias, or under a group SID - must stay revocable, or
/// tightening the grant would strand exactly the accounts it was tightened to prevent.
///
/// It works from derived account names rather than from `WindowsTierIdentity`, because that type
/// carries the granting gate in its constructor: building one in order to delete something would
/// couple removal to the rule it has to outlive. The names are derived by the same function the
/// granting path uses, so there is still one definition of what an owner's accounts are called.
pub fn revoke_owner_state(owner_sid: &str, state_dir: &Path) -> io::Result<()> {
    let owner_sid = canonical_sid(owner_sid)?;
    let mut first_error = None;
    for tier in IsolationTier::ALL {
        if let Err(error) = revoke_tier_state(&account_name_for(&owner_sid, tier), state_dir) {
            first_error.get_or_insert(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Deletes one tier account, its credential blob, its identity record, and every Windows profile an
/// account of that name left behind.
///
/// Every step treats absence as success, so a half-revoked owner converges on a second run rather
/// than failing on what is already gone. Profiles go last because the sweep only removes a profile
/// whose SID no longer maps to an account, which is true of this account's only once it is deleted.
/// Once it is, both remaining steps run even if one fails, and the first error is returned.
fn revoke_tier_state(account_name: &str, state_dir: &Path) -> io::Result<()> {
    // Both machine-wide effects are keyed by the account SID, so remove them while the account still
    // resolves: the DCOM deny that stops the out-of-proc COM path, and the deny logon rights. LSA keeps
    // a right assigned to a deleted SID, and deleting the account alone would strand the DCOM ACE too.
    // Each removal is a no-op when the effect is not present, so a half-revoked owner converges.
    if let Some(sid) = existing_local_user_sid(account_name)? {
        dcom_restriction_windows::remove_tier_dcom_deny(&sid)?;
        account_rights_windows::remove_minimum_logon_rights(&sid)?;
    }
    delete_account(account_name)?;
    let state = state::remove_identity_state(
        state_dir,
        &credential_file_name(account_name),
        &identity_record_file_name(account_name),
    );
    let profiles = remove_orphaned_profiles(account_name);
    state.and(profiles)
}

/// The SID this machine gives a local user account by name, or `None` when the name resolves to no
/// account or to something that is not a local user. `revoke_tier_state` uses it to find the account
/// whose machine-wide DCOM deny has to be removed before the account is deleted.
fn existing_local_user_sid(account_name: &str) -> io::Result<Option<String>> {
    /// `ERROR_NONE_MAPPED`: no account carries the name, so there is nothing to remove.
    const ERROR_NONE_MAPPED: i32 = 1332;
    match lookup_account_sid(account_name) {
        Ok((sid, sid_use)) if sid_use == SidTypeUser && sid.starts_with("S-1-5-21-") => Ok(Some(sid)),
        Ok(_) => Ok(None),
        Err(error) if error.raw_os_error() == Some(ERROR_NONE_MAPPED) => Ok(None),
        Err(error) => Err(error),
    }
}

fn delete_account(account_name: &str) -> io::Result<()> {
    let name = to_wide(account_name);
    // SAFETY: name is a valid NUL-terminated local account name.
    let status = unsafe { NetUserDel(std::ptr::null(), name.as_ptr()) };
    if status == ERROR_SUCCESS || status == NERR_UserNotFound {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

fn classify_presence(
    account_sid: Option<String>,
    credential_present: bool,
    record_present: bool,
) -> io::Result<Option<String>> {
    match (account_sid, credential_present, record_present) {
        (None, false, false) => Ok(None),
        (Some(account_sid), true, true) => Ok(Some(account_sid)),
        (account_sid, credential_present, record_present) => Err(io::Error::other(format!(
            "owner-by-tier identity is inconsistent (account_exists={}, credential_exists={credential_present}, record_exists={record_present})",
            account_sid.is_some()
        ))),
    }
}

/// Whether the provision rollback may delete the half-provisioned account and its state.
///
/// It must not when the machine-wide policy rollback failed: the DCOM deny and the deny rights are both
/// keyed by the account SID, so deleting the account would strand them with no SID left to find them.
/// Keeping the account lets a later revoke retry. Pinned by a test in this module.
fn rollback_deletes_account(machine_rollback: &io::Result<()>) -> bool {
    machine_rollback.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sid_win32::current_process_sid;

    #[test]
    fn a_failed_machine_rollback_keeps_the_account_for_retry() {
        // A successful machine rollback lets the account and its state go; a failed one keeps them, so
        // the DCOM deny and the deny rights - both keyed by the SID - are not stranded.
        assert!(rollback_deletes_account(&Ok(())));
        assert!(!rollback_deletes_account(&Err(io::Error::other("boom"))));
    }

    #[test]
    fn credential_and_record_filenames_come_from_the_shared_naming_module() {
        let owner = "S-1-5-21-100-200-300-1001";
        let account = account_name_for(owner, IsolationTier::NetworkConnector);
        let identity = WindowsTierIdentity {
            owner_sid: owner.to_owned(),
            tier: IsolationTier::NetworkConnector,
            account_name: account.clone(),
            state_dir: PathBuf::from(r"C:\ProgramData\SuperClaw\isolation\identities"),
        };
        assert_eq!(identity.credential_file(), credential_file_name(&account));
        assert_eq!(identity.record_file(), identity_record_file_name(&account));
    }

    #[test]
    fn revoke_reaches_owners_the_granting_gates_refuse() {
        // The whole point of a separate removal path. Every SID here would be turned away by
        // `WindowsTierIdentity::new`, which is what `revoke_owner` used to build: an SDDL alias
        // because the structural gate refuses well-known SIDs, and a group SID because the semantic
        // gate refuses non-users. State provisioned before those gates existed still has to be
        // removable, so revoke must derive the same account names from any SID that names a principal.
        for alias in ["BU", "SY", "WD"] {
            assert!(canonical_owner_sid(alias).is_err(), "{alias}");
            canonical_sid(alias).unwrap();
        }
        // Canonicalizing first is what makes revocation by alias find state provisioned under the
        // raw SID: both spellings derive the same account names.
        for tier in IsolationTier::ALL {
            assert_eq!(
                account_name_for(&canonical_sid("BU").unwrap(), tier),
                account_name_for("S-1-5-32-545", tier)
            );
        }
        // A group SID passes the structural gate and is refused by the semantic one. Revoke applies
        // neither, so a credential provisioned to a group before the gates existed is still removable.
        let group = format!(
            "{}-513",
            current_process_sid().unwrap().rsplit_once('-').unwrap().0
        );
        canonical_sid(&group).unwrap();
        assert!(verify_owner_sid_names_a_user(&group).is_err(), "{group}");

        // A string that names no principal at all is still refused, so a typo cannot pass as a no-op.
        assert!(revoke_owner_state("not-a-sid", Path::new(r"C:\nonexistent")).is_err());
    }

    #[test]
    fn every_partial_identity_state_is_rejected() {
        for account_present in [false, true] {
            for credential_present in [false, true] {
                for record_present in [false, true] {
                    if (!account_present && !credential_present && !record_present)
                        || (account_present && credential_present && record_present)
                    {
                        continue;
                    }
                    let account_sid = account_present.then(|| "S-1-5-21-1-2-3-1001".to_owned());
                    assert!(
                        classify_presence(account_sid, credential_present, record_present).is_err()
                    );
                }
            }
        }
    }

    /// Well formed, structurally an account, and deliberately not an account on this machine.
    const UNRESOLVABLE_ACCOUNT_SID: &str = "S-1-5-21-1178594758-1067165089-3282905936-1013";

    /// The primary-group SID of whatever authority the caller belongs to: "None" on a workgroup
    /// machine, "Domain Users" on a domain-joined one. Derived from the caller's own SID rather than
    /// hard-coded, because a group under `S-1-5-21-` only exists relative to a real machine or domain
    /// and no literal SID can name one on an arbitrary host.
    fn sibling_group_sid() -> String {
        let own = current_process_sid().unwrap();
        let (authority, _rid) = own.rsplit_once('-').unwrap();
        format!("{authority}-513")
    }

    #[test]
    fn the_owner_gate_accepts_the_calling_user() {
        verify_owner_sid_names_a_user(&current_process_sid().unwrap()).unwrap();
    }

    #[test]
    fn the_owner_gate_refuses_a_group_the_structural_check_lets_through() {
        // The residue the structural check cannot reach: a group SID shares the `S-1-5-21-` space
        // with users, so `canonical_owner_sid` accepts it, and as a credential owner it would give
        // every member of the group read access to every tier password.
        let group = sibling_group_sid();
        canonical_owner_sid(&group).expect("a group SID must pass the structural check");
        if resolved_sid_use(&group).unwrap().is_none() {
            // Say so rather than passing quietly: on such a host the refusal is unexercised, and
            // this is the one assertion that needs a resolvable group to mean anything.
            eprintln!("skipping the group-owner case: {group} resolves to no account on this host");
            return;
        }
        let error = verify_owner_sid_names_a_user(&group).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(
            error.to_string().contains("must name a user account"),
            "{error}"
        );
    }

    #[test]
    fn the_owner_gate_refuses_an_account_sid_that_resolves_to_nothing() {
        // Fail-closed on the unresolvable case, because every caller of this gate is about to write
        // an owner ACE. "This machine cannot say what that SID is" is not a reason to grant it read
        // access to every tier password: an unreachable domain controller is exactly how a domain
        // *group* SID reaches here looking indistinguishable from a user.
        assert!(
            resolved_sid_use(UNRESOLVABLE_ACCOUNT_SID)
                .unwrap()
                .is_none()
        );
        let error = verify_owner_sid_names_a_user(UNRESOLVABLE_ACCOUNT_SID).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(
            error.to_string().contains("resolves to no account"),
            "{error}"
        );
    }

    #[test]
    fn the_owner_gate_still_applies_the_structural_refusals() {
        // The gate is additive: it runs `canonical_owner_sid` first, so an alias that canonicalizes
        // to a well-known SID is refused before any name resolution happens.
        for rejected in [
            "WD",
            "S-1-1-0",
            "BU",
            "AU",
            "BA",
            "SY",
            "CO",
            "IU",
            "not-a-sid",
        ] {
            assert_eq!(
                verify_owner_sid_names_a_user(rejected).unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "{rejected}"
            );
        }
    }
}

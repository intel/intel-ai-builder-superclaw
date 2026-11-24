use crate::IsolationTier;
use crate::account_rights_windows;
use crate::identity_windows::{
    IdentityStatus, WindowsTierIdentity, verify_owner_sid_names_a_user,
};
use crate::state;
use serde::Serialize;
use std::io;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IdentityReceipt {
    pub owner_sid: String,
    pub tier: String,
    pub account_name: String,
    pub account_sid: String,
    pub revision: u64,
    /// The account's logon rights as read back after provisioning, including the deny rights issue
    /// #3011 removes. `LsaAddAccountRights` returning success is not evidence the account holds
    /// them, so the readback travels on the receipt.
    pub logon_rights: Vec<String>,
}

pub struct BrokerAuthorization {
    _private: (),
}

pub fn broker_authorization() -> BrokerAuthorization {
    BrokerAuthorization { _private: () }
}

pub fn provision_owner(
    _authorization: &BrokerAuthorization,
    owner_sid: &str,
) -> io::Result<Vec<IdentityReceipt>> {
    // Provision is where an owner SID first turns into credential ACEs, so it is where the half of
    // the owner gate that is too expensive to run per descriptor runs first: a SID this machine
    // resolves to a group would hand every member of that group read access to every tier password.
    // Refused here, before any account, profile or blob exists, rather than rolled back afterwards.
    // This is the earliest refusal and not the only one - `write_credential` and the widening branch
    // of the converging read repeat it, so no path can mint an owner ACE by skipping this entry point.
    verify_owner_sid_names_a_user(owner_sid)?;
    provision_owner_in(owner_sid, state::default_state_dir()?)
}

/// Removal is not gated the way provision is, on purpose: see `identity_windows::revoke_owner_state`.
/// An owner whose state predates the granting gates has to remain revocable.
pub fn revoke_owner(_authorization: &BrokerAuthorization, owner_sid: &str) -> io::Result<()> {
    // Every step runs even if an earlier one fails, so a half-provisioned owner is still cleared.
    let acl = crate::workspace_grant::revoke_applied_acl(owner_sid);
    let identities = state::default_state_dir()
        .and_then(|state_dir| crate::identity_windows::revoke_owner_state(owner_sid, &state_dir));
    let snapshot = crate::workspace_grant::revoke_workspace_authorization(owner_sid);
    // WFP goes last and is independent of the rest: an engine that cannot be opened (BFE stopped)
    // must not strand an account, and a stuck account must not strand a filter.
    let wfp = crate::wfp::revoke_installed(owner_sid);
    combine_revoke_steps(vec![
        ("workspace_acl", acl),
        ("identities", identities),
        ("workspace_authorization", snapshot),
        ("wfp", wfp),
    ])
}

/// Folds the results of steps that have all already run into one result. The error keeps the first
/// failure's kind, so the refusal code is stable, and names every failed step so the uninstall log
/// says which cleanup is left over.
fn combine_revoke_steps(steps: Vec<(&'static str, io::Result<()>)>) -> io::Result<()> {
    let failures: Vec<(&'static str, io::Error)> = steps
        .into_iter()
        .filter_map(|(name, result)| result.err().map(|error| (name, error)))
        .collect();
    let Some((_, first)) = failures.first() else {
        return Ok(());
    };
    let kind = first.kind();
    let detail = failures
        .iter()
        .map(|(name, error)| format!("{name}: {error}"))
        .collect::<Vec<_>>()
        .join("; ");
    Err(io::Error::new(kind, detail))
}

fn provision_owner_in(owner_sid: &str, state_dir: PathBuf) -> io::Result<Vec<IdentityReceipt>> {
    let identities = identities(owner_sid, state_dir)?;
    let initially_absent = identities
        .iter()
        .map(|identity| {
            identity
                .status()
                .map(|status| status == IdentityStatus::Absent)
        })
        .collect::<io::Result<Vec<_>>>()?;
    let mut completed = Vec::new();
    let mut ensured: Vec<usize> = Vec::new();

    for (index, identity) in identities.iter().enumerate() {
        // Reading the rights back is part of the same fallible step as the provision, so a readback
        // that cannot be completed triggers the same rollback a failed provision does. The account
        // SID comes from the identity just ensured, so the rights read and the rights applied are
        // for the same account. The index is recorded for rollback as soon as the account exists -
        // before the readback - so a readback failure still rolls this tier back.
        let result = identity.ensure_provisioned().and_then(|provisioned| {
            ensured.push(index);
            let logon_rights =
                account_rights_windows::read_account_rights(&provisioned.account_sid)?;
            Ok((provisioned, logon_rights))
        });
        match result {
            Ok((provisioned, logon_rights)) => completed.push((index, provisioned, logon_rights)),
            Err(error) => {
                let mut rollback_errors = Vec::new();
                for rollback_index in provision_rollback_targets(&initially_absent, &ensured) {
                    if let Err(rollback_error) = identities[rollback_index].revoke() {
                        rollback_errors.push(rollback_error.to_string());
                    }
                }
                return if rollback_errors.is_empty() {
                    Err(error)
                } else {
                    Err(io::Error::other(format!(
                        "owner provision failed ({error}); rollback also failed ({})",
                        rollback_errors.join("; ")
                    )))
                };
            }
        }
    }

    Ok(completed
        .into_iter()
        .map(|(_, identity, logon_rights)| IdentityReceipt {
            owner_sid: identity.owner_sid,
            tier: identity.tier.as_str().to_owned(),
            account_name: identity.account_name,
            account_sid: identity.account_sid,
            revision: identity.revision,
            logon_rights,
        })
        .collect())
}

/// The identities a failed owner provision has to undo, in the order to undo them.
///
/// Two rules, both of which the caller cannot express as a plain loop without getting them subtly
/// wrong: undo in reverse completion order, and only touch identities this call created. An identity
/// that was already provisioned before the call is left alone - `ensure_provisioned` returned it
/// untouched, so revoking it would delete an account and credential the failure never produced.
fn provision_rollback_targets(initially_absent: &[bool], completed: &[usize]) -> Vec<usize> {
    completed
        .iter()
        .rev()
        .copied()
        .filter(|index| initially_absent[*index])
        .collect()
}

fn identities(owner_sid: &str, state_dir: PathBuf) -> io::Result<Vec<WindowsTierIdentity>> {
    IsolationTier::ALL
        .into_iter()
        .map(|tier| WindowsTierIdentity::new(owner_sid, tier, state_dir.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollback_undoes_only_this_calls_identities_in_reverse_order() {
        // Tier 0 already existed, tiers 1 and 2 were created here, tier 2's provision then failed
        // after tier 1 completed.
        assert_eq!(
            provision_rollback_targets(&[false, true, true], &[0, 1]),
            vec![1]
        );
        assert_eq!(
            provision_rollback_targets(&[true, true, true], &[0, 1]),
            vec![1, 0]
        );
    }

    #[test]
    fn rollback_is_empty_when_nothing_was_created() {
        assert_eq!(
            provision_rollback_targets(&[false, false, false], &[0, 1]),
            Vec::<usize>::new()
        );
        // First tier failed outright: nothing completed, so nothing to undo.
        assert_eq!(
            provision_rollback_targets(&[true, true, true], &[]),
            Vec::<usize>::new()
        );
    }

    #[test]
    fn a_wfp_failure_is_reported_alongside_a_clean_account_removal() {
        let error = combine_revoke_steps(vec![
            ("identities", Ok(())),
            ("wfp", Err(io::Error::other("BFE stopped"))),
        ])
        .expect_err("a failed step is a failed revoke");
        assert_eq!(error.to_string(), "wfp: BFE stopped");
    }

    #[test]
    fn every_failed_step_is_named_and_the_first_kind_is_kept() {
        let error = combine_revoke_steps(vec![
            (
                "identities",
                Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied")),
            ),
            ("workspace_acl", Ok(())),
            ("wfp", Err(io::Error::other("BFE stopped"))),
        ])
        .expect_err("two steps failed");
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(error.to_string(), "identities: denied; wfp: BFE stopped");
    }

    #[test]
    fn all_steps_clean_is_success() {
        assert!(combine_revoke_steps(vec![("identities", Ok(())), ("wfp", Ok(()))]).is_ok());
    }
}

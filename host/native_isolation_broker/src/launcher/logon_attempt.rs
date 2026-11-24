//! The owner hop's credential read and the cross-account logon that starts the tier bootstrap, with its
//! one retry, and the refusal every logon failure ends in.

use super::logon::{
    LogonAttemptError, LogonChild, LogonFailureClass, TierLogonSpec, classify_logon_error,
    local_logon_denial, spawn_with_logon,
};
use super::refusal::{RefusalContext, TierLaunchRefusal, TierLaunchRefusalReason, refuse};
use super::seclogon::seclogon_state;
use crate::credential_read::read_credential_for_owner;
use crate::secrets::unprotect_zeroized;
use crate::zeroize::ZeroizedWide;
use std::io;
use std::path::Path;

/// Attempts one cross-account logon is allowed. Two: the first, and one retry against a freshly reread
/// credential. Named rather than written as a literal because the whole retry policy is this number.
pub(super) const LOGON_ATTEMPTS: u32 = 2;

/// Reads the credential and logs on, retrying once against a freshly reread credential.
///
/// The reread is inside the loop rather than outside it, and that is the whole point: execution plan P4
/// requires the retry to see whatever the credential file says *now*, because the benign cause of
/// `ERROR_LOGON_FAILURE` here is a provision that rotated the password between this launcher's read and
/// its logon. `read_credential_for_owner` is one atomic read of one object, so a retry cannot mix the
/// descriptor of one file with the bytes of another. It also means the password container is dropped,
/// and therefore zeroed, once per attempt rather than once per launch.
///
/// A failed logon creates no process, so nothing connected to any pipe and the same servers and the same
/// per-launch key are still unused. Recreating them would be the bug, not the reuse: a second pipe id
/// would leave the first set listening on names the retry's bootstrap never dials.
pub(super) fn start_with_logon(
    context: &RefusalContext<'_>,
    credential: &Path,
    executable: &Path,
    command: &str,
    environment: &[(String, String)],
) -> io::Result<LogonChild> {
    for attempt in 1..=LOGON_ATTEMPTS {
        let password = read_password(context, credential)?;
        let outcome = spawn_with_logon(&TierLogonSpec {
            account_name: context.account_name,
            password: &password,
            executable,
            command,
            environment,
        });
        // Before the result is even inspected: there is no branch below on which the plaintext is
        // still needed, so there is no branch on which it should still exist.
        drop(password);

        match outcome {
            Ok(child) => return Ok(child),
            Err(LogonAttemptError::Preparation(error)) => return Err(error),
            Err(LogonAttemptError::Logon(code)) => {
                if !classify_logon_error(code).is_retryable() || attempt == LOGON_ATTEMPTS {
                    return Err(logon_refusal(context, executable, code, attempt));
                }
            }
        }
    }
    // Unreachable: `LOGON_ATTEMPTS` is non-zero, so the loop either returns or exhausts its attempts
    // through the branch above. Spelled out rather than left to `unreachable!`, because a panic in a
    // launcher is a worse failure than an error.
    Err(io::Error::other(
        "the tier logon loop ended without an outcome",
    ))
}

/// Reads the exact owner-readable credential and turns it into a password buffer.
///
/// Three failure classes, one refusal: a credential that is absent, whose descriptor has drifted, or
/// whose contents will not decrypt are all resolved by re-provisioning, and none of them is a Win32
/// fault the operator can act on differently. The detail carries which one it was.
fn read_password(context: &RefusalContext<'_>, credential: &Path) -> io::Result<ZeroizedWide> {
    let provision = |detail: String| {
        refuse(
            context,
            TierLaunchRefusal::new(TierLaunchRefusalReason::ProvisionRequired, detail),
        )
    };
    let blob = read_credential_for_owner(credential, context.owner_sid).map_err(|error| {
        provision(match error.kind() {
            io::ErrorKind::NotFound => {
                format!(
                    "no credential file exists at {} ({error})",
                    credential.display()
                )
            }
            _ => format!(
                "the credential at {} is unusable ({error})",
                credential.display()
            ),
        })
    })?;
    let decrypted = unprotect_zeroized(&blob)
        .map_err(|error| provision(format!("the stored credential does not decrypt ({error})")))?;
    ZeroizedWide::from_utf8(decrypted.as_slice()).map_err(|error| provision(error.to_string()))
}

/// Turns one Win32 logon code into the refusal an operator can act on.
///
/// The service state is consulted only for a code that has no established meaning or that leaves the
/// service as the likely cause, and only after the attempt has already failed. Never before: `seclogon`
/// is demand-started, so "not running" a moment before a successful logon is the normal case, and
/// checking first would refuse launches that work.
///
/// `image` is here because one class is about that file rather than about the account, and a refusal
/// that named a prerequisite without naming the path it applies to would not be actionable.
fn logon_refusal(
    context: &RefusalContext<'_>,
    image: &Path,
    code: u32,
    attempts: u32,
) -> io::Error {
    let observed = format!(
        "CreateProcessWithLogonW failed with Win32 error {code} after {attempts} attempt(s)"
    );
    let (reason, detail) = match classify_logon_error(code) {
        LogonFailureClass::RetryableCredential => (
            TierLaunchRefusalReason::ProvisionRequired,
            format!(
                "{observed}; the stored credential did not authenticate, and rereading it did not \
                 help, so it is no longer the account's password"
            ),
        ),
        // Reason `provision_required` because execution plan P4 requires exactly that for both retried
        // codes, and re-provisioning is the one action that re-establishes the account and its
        // credential together. The detail is what keeps the refusal honest: nothing here judged the
        // password, and the service that owns the logon session is the thing to look at first.
        LogonFailureClass::RetryableSession => (
            TierLaunchRefusalReason::ProvisionRequired,
            format!(
                "{observed}; the logon session went away before the credential could be judged, on \
                 both attempts, so nothing observed here says the stored password is wrong; {}",
                seclogon_state().describe()
            ),
        ),
        LogonFailureClass::Provision => (
            TierLaunchRefusalReason::ProvisionRequired,
            format!("{observed}; the account cannot log on in the state it is in"),
        ),
        LogonFailureClass::LocalLogonDenied => (
            TierLaunchRefusalReason::LocalLogonDenied,
            format!("{observed}; {}", local_logon_denial(code)),
        ),
        // Still `windows_api_failure` - the reason set is the closed four the contract pins, and this
        // is not an account, a credential or a service problem - but the detail carries the whole
        // prerequisite, and the remedy for that reason sends the reader to the detail first.
        LogonFailureClass::LauncherImageUnreachable => (
            TierLaunchRefusalReason::WindowsApiFailure,
            format!(
                "{observed}; the tier account could not reach the launcher image at {}, which it \
                 needs read and execute on, with traverse on {}; granting that is the ACL work of \
                 execution plan P5 and is not done yet",
                image.display(),
                image.parent().unwrap_or(image).display()
            ),
        ),
        LogonFailureClass::Seclogon => (
            TierLaunchRefusalReason::SeclogonUnavailable,
            format!("{observed}; {}", seclogon_state().describe()),
        ),
        LogonFailureClass::Unclassified => {
            let state = seclogon_state();
            let reason = if state.rules_out_seclogon() {
                TierLaunchRefusalReason::WindowsApiFailure
            } else {
                TierLaunchRefusalReason::SeclogonUnavailable
            };
            (reason, format!("{observed}; {}", state.describe()))
        }
    };
    refuse(context, TierLaunchRefusal::new(reason, detail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_retry_budget_is_exactly_one_reread() {
        assert_eq!(LOGON_ATTEMPTS, 2);
    }
}

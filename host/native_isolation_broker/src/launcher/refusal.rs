//! The typed refusals the owner hop can end in, and the one envelope that carries them out.
//!
//! # Why these are types rather than Win32 codes
//!
//! `CreateProcessWithLogonW` reports a stopped Secondary Logon service, a tier account that has lost
//! its local-logon right, a password that no longer matches the stored credential and a genuine API
//! fault as four unrelated numbers, and a caller that surfaces the number has told the operator
//! nothing. 启动权威 §3.6 names the first two as new environment dependencies of the two-hop design
//! and requires each to have its own actionable refusal; the other two are the pre-existing shapes the
//! same command line can end in. Four reasons is the whole closed set, and `logon.rs` maps every code
//! it can observe onto one of them, so there is no path that emits a raw code without a reason beside
//! it.
//!
//! # What the envelope may contain
//!
//! Tier, owner SID, account name, reason, detail and remedy. Never the credential, in any
//! representation, and never a substring of it: the plaintext only ever exists inside the `zeroize`
//! containers `logon.rs` holds, and no code path passes one to a formatter. That is the reason a
//! refusal is built from a reason and an observation rather than from the failing call's inputs.
//!
//! The refusal goes to standard output as one JSON line, exactly like the success report, so a caller
//! parses one stream either way and distinguishes the two by `event`. A human-readable line goes to
//! standard error and the process exits non-zero, which is what makes the same refusal legible to an
//! operator reading a console and to the Sandbox Manager reading a pipe.

use super::wire::LAUNCHER_CONTRACT_VERSION;
use crate::tier::IsolationTier;
use serde::{Deserialize, Serialize};
use std::io::{self, Write};

/// The `event` discriminator that distinguishes a refusal line from a completion line.
pub const TIER_LAUNCH_REFUSED_EVENT: &str = "tier_launch_refused";

/// The closed set of reasons the owner hop can refuse to launch a tier runner.
///
/// Mirrored by `BrokerTierLaunchRefusalReasonSchema` in
/// `shared/contracts/src/native-isolation-broker-vocabulary.ts`. Adding a variant here without adding
/// it there produces a wire value no consumer can parse, which the golden fixture is there to catch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TierLaunchRefusalReason {
    /// The account, the credential or the credential's protection is not in the state provisioning
    /// leaves behind. Everything on the account-and-credential path lands here, because the operator
    /// action is the same one in every case: re-provision this owner's tier accounts.
    ProvisionRequired,
    /// `CreateProcessWithLogonW` cannot work at all, because the service that implements it is not
    /// running.
    SeclogonUnavailable,
    /// The tier account exists and its password is right, but policy forbids it logging on to this
    /// machine.
    LocalLogonDenied,
    /// A Win32 failure that is not about the account, the credential or the service, or a host
    /// prerequisite the launch does not meet. Usually a code with no established meaning for this
    /// call, and its detail says so. An unsupported host prerequisite is none of the three above
    /// either, so its detail names the prerequisite and the remedy sends the reader there: a launcher
    /// image the tier account cannot reach, and a launcher outside `WinSta0` (`window_station.rs`).
    /// Deliberately last: a code that belongs to one of the reasons above must be classified as that
    /// reason rather than dropped here.
    WindowsApiFailure,
}

impl TierLaunchRefusalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProvisionRequired => "provision_required",
            Self::SeclogonUnavailable => "seclogon_unavailable",
            Self::LocalLogonDenied => "local_logon_denied",
            Self::WindowsApiFailure => "windows_api_failure",
        }
    }

    /// The operator action that resolves this refusal. Part of the wire shape rather than only of the
    /// console text, because the caller that is best placed to show it is not always the one with a
    /// console.
    pub fn remedy(self) -> &'static str {
        match self {
            Self::ProvisionRequired => {
                "re-run elevated provisioning for this owner, which recreates a missing tier account \
                 or credential and reapplies the workspace access control, then start again"
            }
            Self::SeclogonUnavailable => {
                "start the Secondary Logon service and leave its start type at Manual (`sc.exe \
                 config seclogon start= demand` then `sc.exe start seclogon`), then start again"
            }
            Self::LocalLogonDenied => {
                "in the local or domain policy that applies to this machine, remove the tier account \
                 from `Deny log on locally` and leave `Allow log on locally` covering Users, then \
                 start again"
            }
            Self::WindowsApiFailure => {
                "apply the host prerequisite the detail names, if it names one; otherwise no local \
                 remedy is known for this code, so report the whole refusal line, which carries it"
            }
        }
    }

    /// The `io::ErrorKind` the process fails with, so `error_code` in the library maps this refusal to
    /// the same class a caller would infer from the reason.
    fn error_kind(self) -> io::ErrorKind {
        match self {
            Self::ProvisionRequired => io::ErrorKind::NotFound,
            Self::SeclogonUnavailable => io::ErrorKind::Unsupported,
            Self::LocalLogonDenied => io::ErrorKind::PermissionDenied,
            Self::WindowsApiFailure => io::ErrorKind::Other,
        }
    }
}

/// One reason plus the concrete observation behind it.
pub struct TierLaunchRefusal {
    pub reason: TierLaunchRefusalReason,
    pub detail: String,
}

impl TierLaunchRefusal {
    pub fn new(reason: TierLaunchRefusalReason, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }
}

/// Which launch is being refused. Everything here is derived from the command line and from public
/// account naming, so none of it is sensitive.
pub struct RefusalContext<'a> {
    pub tier: IsolationTier,
    pub owner_sid: &'a str,
    pub account_name: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TierLaunchRefusalItem {
    pub reason: String,
    pub detail: String,
    pub remedy: String,
}

/// The single line the owner-side launcher prints when it refuses.
///
/// `refusals` is an array of one rather than a scalar, matching the broker's own refusal envelope: the
/// shape is the reason a future slice can report several findings from one attempt without a consumer
/// having to learn a second layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TierLaunchRefusalReport {
    pub contract_version: u32,
    pub event: String,
    pub tier: String,
    pub owner_sid: String,
    pub account_name: String,
    pub refusals: Vec<TierLaunchRefusalItem>,
}

/// Writes the refusal envelope to standard output and returns the error the process exits with.
///
/// One function does both because they must not come apart: a refusal that printed no envelope would
/// be invisible to the Sandbox Manager, and an envelope followed by a success exit would be worse
/// still. A failure to write the envelope replaces the refusal with the write error, since a caller
/// that cannot be told the reason must not be told success either.
pub fn refuse(context: &RefusalContext<'_>, refusal: TierLaunchRefusal) -> io::Error {
    let mut stdout = io::stdout().lock();
    match write_refusal(&mut stdout, context, &refusal) {
        Ok(()) => io::Error::new(refusal.reason.error_kind(), describe(context, &refusal)),
        Err(error) => io::Error::new(
            error.kind(),
            format!(
                "{}; the refusal envelope could not be written: {error}",
                describe(context, &refusal)
            ),
        ),
    }
}

/// The human-readable form: reason, what was observed, and what to do about it.
fn describe(context: &RefusalContext<'_>, refusal: &TierLaunchRefusal) -> String {
    format!(
        "{}: cannot launch the {} tier runner as {} - {}; {}",
        refusal.reason.as_str(),
        context.tier.as_str(),
        context.account_name,
        refusal.detail,
        refusal.reason.remedy()
    )
}

pub(super) fn write_refusal(
    writer: &mut impl Write,
    context: &RefusalContext<'_>,
    refusal: &TierLaunchRefusal,
) -> io::Result<()> {
    let report = TierLaunchRefusalReport {
        contract_version: LAUNCHER_CONTRACT_VERSION,
        event: TIER_LAUNCH_REFUSED_EVENT.to_owned(),
        tier: context.tier.as_str().to_owned(),
        owner_sid: context.owner_sid.to_owned(),
        account_name: context.account_name.to_owned(),
        refusals: vec![TierLaunchRefusalItem {
            reason: refusal.reason.as_str().to_owned(),
            detail: refusal.detail.clone(),
            remedy: refusal.reason.remedy().to_owned(),
        }],
    };
    let line = serde_json::to_string(&report)
        .map_err(|error| io::Error::other(format!("launch refusal does not serialize: {error}")))?;
    writeln!(writer, "{line}")?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_REASONS: [TierLaunchRefusalReason; 4] = [
        TierLaunchRefusalReason::ProvisionRequired,
        TierLaunchRefusalReason::SeclogonUnavailable,
        TierLaunchRefusalReason::LocalLogonDenied,
        TierLaunchRefusalReason::WindowsApiFailure,
    ];

    fn context() -> RefusalContext<'static> {
        RefusalContext {
            tier: IsolationTier::Bootstrap,
            owner_sid: "S-1-5-21-1-2-3-1001",
            account_name: "SCBBZUMXK5U6MIU7VEA4",
        }
    }

    #[test]
    fn the_envelope_matches_the_wire_shape_the_contract_pins() {
        let mut output = Vec::new();
        write_refusal(
            &mut output,
            &context(),
            &TierLaunchRefusal::new(
                TierLaunchRefusalReason::SeclogonUnavailable,
                "the Secondary Logon service (seclogon) is not running (current state 1)",
            ),
        )
        .unwrap();
        let line = String::from_utf8(output).unwrap();
        assert!(line.ends_with('\n'), "the report is one line");
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["contract_version"], 1);
        assert_eq!(value["event"], TIER_LAUNCH_REFUSED_EVENT);
        assert_eq!(value["tier"], "bootstrap");
        assert_eq!(value["owner_sid"], "S-1-5-21-1-2-3-1001");
        assert_eq!(value["account_name"], "SCBBZUMXK5U6MIU7VEA4");
        assert_eq!(value["refusals"].as_array().unwrap().len(), 1);
        assert_eq!(value["refusals"][0]["reason"], "seclogon_unavailable");
        assert!(
            value["refusals"][0]["detail"]
                .as_str()
                .unwrap()
                .contains("seclogon")
        );
        assert!(
            value["refusals"][0]["remedy"]
                .as_str()
                .unwrap()
                .contains("sc.exe start seclogon")
        );
    }

    /// A reason with no remedy is a reason an operator cannot act on, which is the whole thing these
    /// types exist to avoid. The wire values are asserted as literals because they are a contract.
    #[test]
    fn every_reason_is_actionable_and_has_the_wire_value_the_contract_declares() {
        assert_eq!(
            ALL_REASONS.map(TierLaunchRefusalReason::as_str),
            [
                "provision_required",
                "seclogon_unavailable",
                "local_logon_denied",
                "windows_api_failure",
            ]
        );
        for reason in ALL_REASONS {
            let remedy = reason.remedy();
            assert!(remedy.len() > 40, "{} has no real remedy", reason.as_str());
            assert!(
                !remedy.contains("  "),
                "{}'s remedy has a line-continuation artifact: {remedy}",
                reason.as_str()
            );
        }
    }

    #[test]
    fn the_human_readable_form_names_the_account_the_observation_and_the_remedy() {
        let text = describe(
            &context(),
            &TierLaunchRefusal::new(
                TierLaunchRefusalReason::ProvisionRequired,
                "no credential file exists for this account",
            ),
        );
        assert!(text.starts_with("provision_required: "));
        assert!(text.contains("bootstrap"));
        assert!(text.contains("SCBBZUMXK5U6MIU7VEA4"));
        assert!(text.contains("no credential file exists"));
        assert!(text.contains("re-run elevated provisioning"));
    }

    /// Each reason maps onto a distinct error class, so the exit-path classification in
    /// `error_code` cannot collapse two of them into one.
    #[test]
    fn distinct_reasons_fail_with_distinct_error_classes() {
        let kinds: Vec<io::ErrorKind> = ALL_REASONS
            .iter()
            .map(|reason| reason.error_kind())
            .collect();
        for (index, kind) in kinds.iter().enumerate() {
            assert!(
                !kinds[..index].contains(kind),
                "{} shares an error kind with an earlier reason",
                ALL_REASONS[index].as_str()
            );
        }
    }
}

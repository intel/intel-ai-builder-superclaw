//! The WFP egress filters a provision installs.
//!
//! Two trees. `read` is the read-only half - the plan check, the tables, the filters a plan names, the
//! engine opened to read and the readback - and is the only part the unelevated launcher compiles. This
//! module is the elevated half: `apply` installs a plan in one WFP transaction and reads every filter
//! back by key, `engine_win32` is the engine opened to write, and the entries below are reached only from
//! the broker's provision session and `--revoke`.
//!
//! A plan arrives as caller input. `read::plan` checks it from scratch against the shipped descriptor's
//! tables, `read::filters` turns each planned object into the filters it names. `read::contract` holds
//! the tables, embedded from the generated descriptor rather than restated; `read::key` holds the one
//! derivation of a filter's key.
//!
//! There is no provider. The sublayer and every filter carry `providerKey = NULL` and are told apart by
//! their fixed keys and their `providerData` tag, which is also how EC4 identifies our objects.

mod apply;
mod engine_win32;
pub(crate) mod read;

#[cfg(test)]
use read::{contract, filters, key, plan};
pub(crate) use read::{WfpReadFailure, read_back_installed};
#[cfg(test)]
pub(crate) use read::readback_with;

#[cfg(test)]
mod tests;

use crate::identity_windows::{IdentityStatus, IsolationTier, WindowsTierIdentity};
use read::contract::Tier;
use std::collections::BTreeMap;
use std::io;

/// Removes every WFP object this product owns from the machine: the filters in our sublayer, then the
/// sublayer, in one transaction. Nothing installed is success, so an uninstall can run it blind.
///
/// Elevated: opening a writable engine session needs the broker's token, which is why this is reached
/// only from the broker's `--revoke`. `owner_sid` is only the principal a session would grant read on
/// objects it adds; a revoke adds none.
pub(crate) fn revoke_installed(owner_sid: &str) -> io::Result<()> {
    let mut engine = engine_win32::Win32WfpEngine::open(owner_sid)?;
    apply::revoke_all(&mut engine)
        .map(|_| ())
        .map_err(|refusal| io::Error::other(format!("wfp revoke refused: {refusal:?}")))
}

/// Why a plan was not installed. The code is what crosses to the caller; nothing free-form leaves the
/// privileged side.
#[derive(Debug)]
pub(crate) enum WfpPlanFailure {
    /// The plan was refused before anything was written.
    Plan(read::plan::WfpPlanRefusal),
    /// The plan was for another owner than the one this operation authenticated.
    OwnerMismatch,
    /// The plan holds filters. This build installs only the presence anchor: a filter that can block is
    /// written by the stage that turns enforcement on, not by a provision of the permissive policy.
    ObjectsNotInstallable,
    /// The applier refused, or aborted its transaction; nothing of this plan is installed.
    Apply(apply::WfpApplyRefusal),
    /// The engine could not be opened or read.
    Engine(io::Error),
}

impl WfpPlanFailure {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Plan(_) => "wfp_plan_refused",
            Self::OwnerMismatch => "wfp_plan_owner_mismatch",
            Self::ObjectsNotInstallable => "wfp_objects_not_installable",
            Self::Apply(_) => "wfp_apply_refused",
            Self::Engine(_) => "wfp_engine_unavailable",
        }
    }
}

impl From<WfpReadFailure> for WfpPlanFailure {
    fn from(failure: WfpReadFailure) -> Self {
        match failure {
            WfpReadFailure::Plan(refusal) => Self::Plan(refusal),
            WfpReadFailure::OwnerMismatch => Self::OwnerMismatch,
            WfpReadFailure::Engine(error) => Self::Engine(error),
        }
    }
}

/// Installs a plan through any engine: the plan is checked from scratch, then applied in one
/// transaction. Under the shipped permissive policy that is our sublayer and no filter.
pub(crate) fn install_with<E: apply::WfpEngine>(
    engine: &mut E,
    owner_sid: &str,
    plan_bytes: &[u8],
) -> Result<apply::ApplyOutcome, WfpPlanFailure> {
    let plan = read::validated_for(owner_sid, plan_bytes)?;
    apply::apply_plan(engine, &plan).map_err(WfpPlanFailure::Apply)
}

/// The plan a provision may install: valid, this owner's, and holding no filter.
///
/// An object must also name the account provisioned for its tier. The plan check only knows a SID's
/// shape, and a local group SID has the same shape; if the owner's token held that group, an
/// `ALE_USER_ID` condition on it would match the owner. `provisioned` is read only when the plan
/// holds an object.
pub(crate) fn check_installable(
    owner_sid: &str,
    plan_bytes: &[u8],
    provisioned: impl FnOnce() -> io::Result<BTreeMap<Tier, String>>,
) -> Result<read::plan::ValidatedWfpPlan, WfpPlanFailure> {
    let plan = read::validated_for(owner_sid, plan_bytes)?;
    if !plan.objects.is_empty() {
        let provisioned = provisioned().map_err(WfpPlanFailure::Engine)?;
        if plan
            .objects
            .iter()
            .any(|object| provisioned.get(&object.tier) != Some(&object.account_sid))
        {
            return Err(WfpPlanFailure::Plan(read::plan::WfpPlanRefusal::AccountNotATierAccount));
        }
        return Err(WfpPlanFailure::ObjectsNotInstallable);
    }
    Ok(plan)
}

/// The account SID provisioned for each tier this owner has.
fn provisioned_tier_accounts(owner_sid: &str) -> io::Result<BTreeMap<Tier, String>> {
    let state_dir = crate::state::default_state_dir()?;
    let mut accounts = BTreeMap::new();
    for isolation_tier in IsolationTier::ALL {
        let named = isolation_tier.as_str();
        let Some(tier) = Tier::ALL.into_iter().find(|tier| tier.as_str() == named) else {
            continue;
        };
        let identity = WindowsTierIdentity::new(owner_sid, isolation_tier, state_dir.clone())?;
        if let IdentityStatus::Provisioned(provisioned) = identity.status()? {
            accounts.insert(tier, provisioned.account_sid);
        }
    }
    Ok(accounts)
}

/// Installs the plan on this machine. Elevated, and reached only from the provision session, which is
/// the one elevation a start costs. What it writes is our sublayer and no filter.
pub(crate) fn install_plan(owner_sid: &str, plan_bytes: &[u8]) -> Result<(), WfpPlanFailure> {
    // The plan is checked before the engine is opened, so a malformed plan touches nothing.
    check_installable(owner_sid, plan_bytes, || provisioned_tier_accounts(owner_sid))?;
    let mut engine = engine_win32::Win32WfpEngine::open(owner_sid).map_err(WfpPlanFailure::Engine)?;
    install_with(&mut engine, owner_sid, plan_bytes).map(|_| ())
}

#[cfg(test)]
pub(crate) fn plan_refusal_for_tests() -> read::plan::WfpPlanRefusal {
    read::plan::WfpPlanRefusal::ShapeInvalid
}

#[cfg(test)]
pub(crate) fn apply_refusal_for_tests() -> apply::WfpApplyRefusal {
    apply::WfpApplyRefusal::TransactionAborted
}

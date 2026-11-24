//! The read-only half of the WFP module: the part the unelevated launcher compiles.
//!
//! `contract` holds the tables embedded from the generated descriptor, `key` the one derivation of a
//! filter's key, `plan` the from-scratch check of a plan, `filters` what a plan's objects become,
//! `readback` the comparison of the engine with a plan, and `engine` the engine opened to read.
//!
//! Nothing in this tree can write. The `WfpReader` seam has no write method, and `engine` carries no
//! `FwpmTransaction*`, `Fwpm*Add0` or `Fwpm*Delete*` call; `engine_win32` and `apply`, which do, are not
//! in this tree and are not compiled into the launcher. `tests/launcher_closure.rs` pins both facts: the
//! launcher's module closure names this tree and not those, and its import table has none of those calls.

pub(crate) mod contract;
pub(crate) mod engine;
pub(crate) mod filters;
pub(crate) mod key;
pub(crate) mod plan;
pub(crate) mod readback;

use filters::DesiredFilter;
use std::io;

/// A filter as the engine reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstalledFilter {
    pub filter: DesiredFilter,
    pub sublayer: u128,
    pub provider_data: Vec<u8>,
}

/// A sublayer as the engine reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstalledSublayer {
    pub key: u128,
    pub weight: u16,
    /// The `providerData` tag the sublayer carries, empty if it has none.
    pub provider_data: Vec<u8>,
}

/// What a readback may ask of the engine. There is deliberately no method that changes anything.
pub(crate) trait WfpReader {
    fn sublayer(&mut self, key: u128) -> io::Result<Option<InstalledSublayer>>;
    fn filter(&mut self, key: u128) -> io::Result<Option<InstalledFilter>>;
    /// The keys of every filter in this sublayer, whichever plan installed it.
    fn filters_in_sublayer(&mut self, sublayer: u128) -> io::Result<Vec<u128>>;
}

/// Why a plan was not read back. The code is what crosses to the caller.
#[derive(Debug)]
pub(crate) enum WfpReadFailure {
    /// The plan was refused before anything was read.
    Plan(plan::WfpPlanRefusal),
    /// The plan was for another owner than the one the caller named.
    OwnerMismatch,
    /// The engine could not be opened or read.
    Engine(io::Error),
}

impl WfpReadFailure {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Plan(_) => "wfp_plan_refused",
            Self::OwnerMismatch => "wfp_plan_owner_mismatch",
            Self::Engine(_) => "wfp_engine_unavailable",
        }
    }
}

/// A plan that is valid and this owner's.
pub(crate) fn validated_for(
    owner_sid: &str,
    plan_bytes: &[u8],
) -> Result<plan::ValidatedWfpPlan, WfpReadFailure> {
    let plan = plan::validate_plan(plan_bytes).map_err(WfpReadFailure::Plan)?;
    if plan.owner_sid != owner_sid {
        return Err(WfpReadFailure::OwnerMismatch);
    }
    Ok(plan)
}

/// The readback verdict as the JSON the unelevated `--wfp-readback` mode prints.
pub(crate) fn readback_with<E: WfpReader>(
    engine: &mut E,
    owner_sid: &str,
    plan_bytes: &[u8],
) -> Result<serde_json::Value, WfpReadFailure> {
    let plan = validated_for(owner_sid, plan_bytes)?;
    let report = readback::read_back(engine, &plan).map_err(WfpReadFailure::Engine)?;
    let verdict = if report.is_consistent(&plan) {
        "consistent"
    } else {
        "drifted"
    };
    let mut value = serde_json::to_value(&report).map_err(|error| WfpReadFailure::Engine(error.into()))?;
    value["verdict"] = serde_json::Value::from(verdict);
    Ok(value)
}

/// Reads our objects back on this machine, with the caller's own token: no elevation is requested.
pub(crate) fn read_back_installed(
    owner_sid: &str,
    plan_bytes: &[u8],
) -> Result<serde_json::Value, WfpReadFailure> {
    validated_for(owner_sid, plan_bytes)?;
    let mut engine = engine::Win32WfpReader::open().map_err(WfpReadFailure::Engine)?;
    readback_with(&mut engine, owner_sid, plan_bytes)
}

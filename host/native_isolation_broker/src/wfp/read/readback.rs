//! Reading our WFP objects back and comparing them with a plan.
//!
//! Reads only: nothing here begins a transaction or writes, and the real engine behind it is opened by
//! the unelevated caller. The owner's account is what makes that work - every object the applier adds
//! carries a security descriptor granting the owner read - so a readback needs no elevation, and a
//! caller that is refused simply has no verdict, which is `not_read` in the isolation report rather
//! than a guess.
//!
//! What it speaks about is our sublayer and what is in it, not the machine's filters: the sublayer when
//! the plan asks for it, every filter the plan wants by key, and every filter found in our sublayer
//! that the plan does not want. A filter in somebody else's sublayer is not read.

use super::{InstalledFilter, WfpReader};
use super::contract::{WfpRules, wfp_rules};
use super::key::filter_key;
use super::filters::desired_filters;
use super::plan::ValidatedWfpPlan;
use serde::Serialize;
use std::collections::BTreeSet;
use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SublayerState {
    Present,
    Absent,
    /// A sublayer holds our key with a weight we never write; it is not ours to judge or touch.
    NotOurs,
    /// Our sublayer carries no `providerData` tag, where the plan wants one.
    TagMissing,
    /// Our sublayer carries a tag other than the plan's: an older plan's, or one someone altered.
    TagMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Enumeration {
    Complete,
    Denied,
}

/// What the readback found, as counts and keys; the verdict is derived from them and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ReadbackReport {
    pub sublayer: SublayerState,
    /// Whether our sublayer could be enumerated. An unelevated caller cannot (the engine refuses the enumerate
    /// right), so denied says the extra-filter check covered only the keys the plan derives.
    pub enumeration: Enumeration,
    pub expected_filters: usize,
    pub observed_filters: usize,
    /// Planned filters that are not in the engine.
    pub missing: Vec<String>,
    /// Planned filters that are in the engine with other content.
    pub changed: Vec<String>,
    /// Filters in our sublayer that the plan does not want.
    pub extra: Vec<String>,
}

impl ReadbackReport {
    /// Whether every object the plan speaks about is as the plan says, and nothing else is ours.
    pub(crate) fn is_consistent(&self, plan: &ValidatedWfpPlan) -> bool {
        let sublayer_ok = match self.sublayer {
            SublayerState::Present => plan.install_sublayer || self.expected_filters > 0,
            SublayerState::Absent => !plan.install_sublayer && self.expected_filters == 0,
            SublayerState::NotOurs | SublayerState::TagMissing | SublayerState::TagMismatch => false,
        };
        sublayer_ok && self.missing.is_empty() && self.changed.is_empty() && self.extra.is_empty()
    }
}

fn hex(key: u128) -> String {
    format!("{key:032x}")
}

/// Compares the engine with the plan, through reads only.
pub(crate) fn read_back<E: WfpReader>(
    engine: &mut E,
    plan: &ValidatedWfpPlan,
) -> io::Result<ReadbackReport> {
    let rules = wfp_rules().map_err(|_| io::Error::other("the embedded WFP tables are unreadable"))?;
    let wanted: Vec<InstalledFilter> = desired_filters(plan)
        .map_err(|_| io::Error::other("the plan's filters are not derivable"))?
        .into_iter()
        .map(|filter| InstalledFilter {
            filter,
            sublayer: rules.sublayer_key,
            provider_data: plan.provider_data.clone(),
        })
        .collect();

    let sublayer = match engine.sublayer(rules.sublayer_key)? {
        None => SublayerState::Absent,
        Some(found) if found.weight != rules.sublayer_weight => SublayerState::NotOurs,
        // A plan that does not speak about the sublayer does not speak about its tag either.
        Some(_) if !plan.install_sublayer && wanted.is_empty() => SublayerState::Present,
        Some(found) if found.provider_data.is_empty() => SublayerState::TagMissing,
        Some(found) if found.provider_data != plan.provider_data => SublayerState::TagMismatch,
        Some(_) => SublayerState::Present,
    };
    let mut report = ReadbackReport {
        sublayer,
        enumeration: Enumeration::Complete,
        expected_filters: wanted.len(),
        observed_filters: 0,
        missing: Vec::new(),
        changed: Vec::new(),
        extra: Vec::new(),
    };
    if matches!(sublayer, SublayerState::Absent | SublayerState::NotOurs) {
        // Without our sublayer there is nothing of ours to enumerate; every wanted filter is missing.
        report.missing = wanted.iter().map(|want| hex(want.filter.key)).collect();
        return Ok(report);
    }

    // The sublayer was readable by key; its contents may not be enumerable by this caller.
    let observed: Option<BTreeSet<u128>> = match engine.filters_in_sublayer(rules.sublayer_key) {
        Ok(keys) => Some(keys.into_iter().collect()),
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => None,
        Err(error) => return Err(error),
    };
    report.observed_filters = observed.as_ref().map_or(0, BTreeSet::len);
    let wanted_keys: BTreeSet<u128> = wanted.iter().map(|want| want.filter.key).collect();
    for want in &wanted {
        match engine.filter(want.filter.key)? {
            None => report.missing.push(hex(want.filter.key)),
            Some(have) if have != *want => report.changed.push(hex(want.filter.key)),
            Some(_) => {}
        }
    }
    match observed {
        Some(observed) => {
            report.extra = observed.difference(&wanted_keys).copied().map(hex).collect();
        }
        None => {
            // Not enumerable: look at the keys the plan derives for this owner that it does not want, which
            // is every object an earlier version of the contract could have left behind.
            report.enumeration = Enumeration::Denied;
            for key in unwanted_derived_keys(rules, plan, &wanted_keys) {
                if engine.filter(key)?.is_some() {
                    report.extra.push(hex(key));
                }
            }
        }
    }
    Ok(report)
}

/// Every filter key the plan derives from an object it plans or one it removes, less the ones it wants.
fn unwanted_derived_keys(
    rules: &WfpRules,
    plan: &ValidatedWfpPlan,
    wanted_keys: &BTreeSet<u128>,
) -> BTreeSet<u128> {
    let derived = |object_key: &str, class| {
        rules
            .filters_for(class)
            .into_iter()
            .map(|(layer, matched, transport)| filter_key(rules, object_key, layer, matched, transport))
            .collect::<Vec<_>>()
    };
    plan.removals
        .iter()
        .flat_map(|removal| derived(&removal.object_key, removal.class))
        .chain(
            plan.objects
                .iter()
                .flat_map(|object| derived(&object.object_key, object.class)),
        )
        .filter(|key| !wanted_keys.contains(key))
        .collect()
}

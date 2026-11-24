//! Installing a validated plan: one WFP transaction, then a readback of every filter by key.
//!
//! `WfpEngine` is the seam between this logic and `fwpuclnt.dll`, so the transaction discipline - all
//! of the plan or none of it, nothing written when nothing differs - is tested without touching the
//! machine. The real engine is a non-dynamic session, because a dynamic one cannot add persistent
//! objects.
//!
//! The write half only: the reads an apply needs come from `WfpReader`, which is the same seam the
//! unelevated launcher compiles, and this module is not part of that tree.

use super::read::contract::{WfpRules, wfp_rules};
use super::read::filters::desired_filters;
use super::read::key::filter_key;
use super::read::plan::ValidatedWfpPlan;
pub(crate) use super::read::{InstalledFilter, InstalledSublayer, WfpReader};
use std::collections::BTreeSet;
use std::io;

pub(crate) trait WfpEngine: WfpReader {
    fn begin(&mut self) -> io::Result<()>;
    fn commit(&mut self) -> io::Result<()>;
    fn abort(&mut self) -> io::Result<()>;
    fn add_sublayer(&mut self, sublayer: &InstalledSublayer) -> io::Result<()>;
    fn add_filter(&mut self, filter: &InstalledFilter) -> io::Result<()>;
    fn delete_filter(&mut self, key: u128) -> io::Result<()>;
    fn delete_sublayer(&mut self, key: u128) -> io::Result<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RevokeOutcome {
    /// Our sublayer does not exist, so nothing of ours can either.
    NothingInstalled,
    Revoked {
        filters: usize,
    },
}

/// Removes every filter in our sublayer and then the sublayer, in one transaction.
///
/// By sublayer rather than by plan, because there is no provider to delete by and a plan only names
/// the filters it knows about; an object an older version left behind is still in our sublayer.
pub(crate) fn revoke_all<E: WfpEngine>(engine: &mut E) -> Result<RevokeOutcome, WfpApplyRefusal> {
    let rules = wfp_rules().map_err(|_| ContractUnreadable)?;
    let aborted = |_: io::Error| TransactionAborted;
    engine.begin().map_err(aborted)?;
    let staged = (|| -> Result<Option<usize>, WfpApplyRefusal> {
        match engine.sublayer(rules.sublayer_key).map_err(aborted)? {
            None => return Ok(None),
            // The engine reads a sublayer it did not write as weight 0; it is not ours to delete.
            Some(sublayer) if sublayer.weight != rules.sublayer_weight => {
                return Err(SublayerNotOurs);
            }
            Some(_) => {}
        }
        let keys = engine
            .filters_in_sublayer(rules.sublayer_key)
            .map_err(aborted)?;
        for &key in &keys {
            engine.delete_filter(key).map_err(aborted)?;
        }
        engine
            .delete_sublayer(rules.sublayer_key)
            .map_err(aborted)?;
        Ok(Some(keys.len()))
    })();
    let filters = match staged {
        Ok(Some(filters)) => filters,
        Ok(None) => {
            engine.abort().map_err(aborted)?;
            return Ok(RevokeOutcome::NothingInstalled);
        }
        Err(refusal) => {
            let _ = engine.abort();
            return Err(refusal);
        }
    };
    engine.commit().map_err(aborted)?;
    match engine.sublayer(rules.sublayer_key) {
        Ok(None) => Ok(RevokeOutcome::Revoked { filters }),
        _ => Err(ReadbackMismatch {
            key: rules.sublayer_key,
        }),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplyOutcome {
    /// Every filter already matched the plan; nothing was written.
    AlreadyConverged,
    Applied {
        added: usize,
        deleted: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WfpApplyRefusal {
    /// The embedded descriptor could not be read, so there was nothing to compare against.
    ContractUnreadable,
    /// The engine refused a step; the transaction was aborted, so nothing of this plan is installed.
    TransactionAborted,
    /// From `apply_plan`: what was staged read back differently, or not at all, inside the transaction; it
    /// was aborted, so nothing of this plan is installed. From `revoke_all`: our sublayer was still there
    /// after the removal committed.
    ReadbackMismatch { key: u128 },
    /// A sublayer with our key exists with another weight.
    SublayerNotOurs,
}

use WfpApplyRefusal::*;

#[derive(Debug, Default, PartialEq, Eq)]
struct Changes {
    added: usize,
    deleted: usize,
    sublayer_added: bool,
    /// Our sublayer carried another tag than the plan's, so it was deleted and added again.
    sublayer_refreshed: bool,
    /// The plan wants no sublayer and no filter, so ours was deleted with everything in it.
    sublayer_removed: bool,
}

/// Installs the plan's filters and removes the ones it says must not exist and any other filter in our
/// sublayer, in one transaction.
pub(crate) fn apply_plan<E: WfpEngine>(
    engine: &mut E,
    plan: &ValidatedWfpPlan,
) -> Result<ApplyOutcome, WfpApplyRefusal> {
    let rules = wfp_rules().map_err(|_| ContractUnreadable)?;
    let wanted: Vec<InstalledFilter> = desired_filters(plan)
        .map_err(|_| ContractUnreadable)?
        .into_iter()
        .map(|filter| InstalledFilter {
            filter,
            sublayer: rules.sublayer_key,
            provider_data: plan.provider_data.clone(),
        })
        .collect();
    let wanted_keys: BTreeSet<u128> = wanted.iter().map(|want| want.filter.key).collect();
    // A removal deletes every filter its class derives. A planned object also deletes the class
    // filters it no longer names, such as a permit's filter for an address family it has lost.
    let derived = |object_key: &str, class| {
        rules
            .filters_for(class)
            .into_iter()
            .map(|(layer, matched, transport)| {
                filter_key(rules, object_key, layer, matched, transport)
            })
            .collect::<Vec<_>>()
    };
    let removed: Vec<u128> = plan
        .removals
        .iter()
        .flat_map(|removal| derived(&removal.object_key, removal.class))
        .chain(
            plan.objects
                .iter()
                .flat_map(|object| derived(&object.object_key, object.class))
                .filter(|key| !wanted_keys.contains(key)),
        )
        .collect();

    engine.begin().map_err(|_| TransactionAborted)?;
    let changes = match stage(engine, rules, plan, &wanted, &removed) {
        Ok(changes) => changes,
        Err(refusal) => {
            let _ = engine.abort();
            return Err(refusal);
        }
    };
    if changes == Changes::default() {
        engine.abort().map_err(|_| TransactionAborted)?;
        return Ok(ApplyOutcome::AlreadyConverged);
    }
    // The swap is atomic: what was staged has to read back as the plan says before it is committed. A reader
    // inside the transaction sees the staged state, so a mismatch here aborts and leaves the old plan installed.
    if let Err(refusal) = verify_staged(engine, rules, plan, &wanted) {
        let _ = engine.abort();
        return Err(refusal);
    }
    engine.commit().map_err(|_| TransactionAborted)?;

    // Committed, so this is an install. Drift after the commit is the readback path's to report
    // (`--wfp-readback`, the isolation report), not a failure of an install that already happened: a refusal
    // from here always means nothing of this plan was committed.
    Ok(ApplyOutcome::Applied {
        added: changes.added,
        deleted: changes.deleted,
    })
}

/// Reads the staged state back against the plan: our sublayer as written, and every wanted filter by key.
fn verify_staged<E: WfpEngine>(
    engine: &mut E,
    rules: &WfpRules,
    plan: &ValidatedWfpPlan,
    wanted: &[InstalledFilter],
) -> Result<(), WfpApplyRefusal> {
    let staged = engine.sublayer(rules.sublayer_key).map_err(|_| TransactionAborted)?;
    let as_planned = if wants_sublayer(plan, wanted) {
        staged.is_some_and(|sublayer| {
            sublayer.weight == rules.sublayer_weight && sublayer.provider_data == plan.provider_data
        })
    } else {
        staged.is_none()
    };
    if !as_planned {
        return Err(ReadbackMismatch {
            key: rules.sublayer_key,
        });
    }
    for want in wanted {
        match engine.filter(want.filter.key) {
            Ok(Some(have)) if have == *want => {}
            _ => {
                return Err(ReadbackMismatch {
                    key: want.filter.key,
                });
            }
        }
    }
    Ok(())
}

/// Whether the plan speaks for our sublayer; the readback requires it absent when it does not.
fn wants_sublayer(plan: &ValidatedWfpPlan, wanted: &[InstalledFilter]) -> bool {
    plan.install_sublayer || !wanted.is_empty()
}

fn wanted_sublayer(rules: &WfpRules, plan: &ValidatedWfpPlan) -> InstalledSublayer {
    InstalledSublayer {
        key: rules.sublayer_key,
        weight: rules.sublayer_weight,
        provider_data: plan.provider_data.clone(),
    }
}

/// Deletes every filter in our sublayer and then the sublayer, inside the caller's transaction; returns the
/// number of filters deleted.
fn clear_sublayer<E: WfpEngine>(
    engine: &mut E,
    rules: &WfpRules,
) -> Result<usize, WfpApplyRefusal> {
    let aborted = |_: io::Error| TransactionAborted;
    let keys = engine
        .filters_in_sublayer(rules.sublayer_key)
        .map_err(aborted)?;
    for &key in &keys {
        engine.delete_filter(key).map_err(aborted)?;
    }
    engine
        .delete_sublayer(rules.sublayer_key)
        .map_err(aborted)?;
    Ok(keys.len())
}

/// Every write the plan needs, inside the caller's transaction.
fn stage<E: WfpEngine>(
    engine: &mut E,
    rules: &WfpRules,
    plan: &ValidatedWfpPlan,
    wanted: &[InstalledFilter],
    removed: &[u128],
) -> Result<Changes, WfpApplyRefusal> {
    let aborted = |_: io::Error| TransactionAborted;
    let mut changes = Changes::default();
    match engine.sublayer(rules.sublayer_key).map_err(aborted)? {
        Some(sublayer) if sublayer.weight != rules.sublayer_weight => return Err(SublayerNotOurs),
        // An uninstall: everything in our sublayer goes, whatever its tag, then the sublayer itself, as
        // `revoke_all` does. The weight check above is what makes it ours to delete.
        Some(_) if !wants_sublayer(plan, wanted) => {
            changes.deleted += clear_sublayer(engine, rules)?;
            changes.sublayer_removed = true;
        }
        // The tag is how the anchor is told from a stranger's sublayer of our key, so a plan carrying another
        // one refreshes it even when no filter changes. A sublayer cannot be deleted while a filter is in
        // it, so the filters go first and the loops below add back the ones the plan wants.
        Some(sublayer) if sublayer.provider_data != plan.provider_data => {
            changes.deleted += clear_sublayer(engine, rules)?;
            engine
                .add_sublayer(&wanted_sublayer(rules, plan))
                .map_err(aborted)?;
            changes.sublayer_refreshed = true;
        }
        // Whatever else is in our sublayer is ours under a key this plan does not want, such as one an older
        // plan or version left behind; it goes, or a stale block would outlive the plan that replaced it.
        Some(_) => {
            let keys = engine
                .filters_in_sublayer(rules.sublayer_key)
                .map_err(aborted)?;
            for key in keys {
                if !wanted.iter().any(|want| want.filter.key == key) {
                    engine.delete_filter(key).map_err(aborted)?;
                    changes.deleted += 1;
                }
            }
        }
        None if !wants_sublayer(plan, wanted) => {}
        None => {
            engine
                .add_sublayer(&wanted_sublayer(rules, plan))
                .map_err(aborted)?;
            changes.sublayer_added = true;
        }
    }
    for &key in removed {
        if engine.filter(key).map_err(aborted)?.is_some() {
            engine.delete_filter(key).map_err(aborted)?;
            changes.deleted += 1;
        }
    }
    for want in wanted {
        match engine.filter(want.filter.key).map_err(aborted)? {
            Some(have) if have == *want => {}
            Some(_) => {
                engine.delete_filter(want.filter.key).map_err(aborted)?;
                changes.deleted += 1;
                engine.add_filter(want).map_err(aborted)?;
                changes.added += 1;
            }
            None => {
                engine.add_filter(want).map_err(aborted)?;
                changes.added += 1;
            }
        }
    }
    Ok(changes)
}

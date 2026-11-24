//! Tests for the WFP applier: keys against the shared golden vectors, plans as caller input, the
//! filters a plan names, and the transaction discipline against a fake engine.
//!
//! Nothing here opens the real filtering engine. Installing an object is a machine change that waits
//! for its own elevated gate, in `log_only` first.

use super::apply::{InstalledFilter, InstalledSublayer, WfpEngine, WfpReader};
use super::contract::wfp_rules;
use super::filters::FilterAction;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;

mod anchor_tag_tests;
mod apply_tests;
mod engine_tests;
mod filter_tests;
mod golden_plan_tests;
mod key_tests;
mod loopback_port_tests;
mod plan_tests;
mod readback_tests;
mod upstream_tests;

pub(super) const OWNER: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";
pub(super) const FILE_TOOL_SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1002";
pub(super) const BOOTSTRAP_SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1003";

pub(super) fn shared_fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("shared")
        .join("contracts")
        .join("test-fixtures")
        .join(name);
    serde_json::from_slice(&std::fs::read(&path).expect("the shared fixture is readable"))
        .expect("the shared fixture is JSON")
}

pub(super) const CONNECTOR_SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1004";

pub(super) fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("a JSON value serializes")
}

pub(super) fn object_key(class: &str, tier: &str, owner: &str) -> String {
    format!("openwork-egress.wfp.{class}.{tier}.{owner}")
}

/// `address_sets.loopback` of the v2 descriptor, verbatim.
pub(super) fn loopback_ranges() -> Value {
    json!([
        {"address_family": "ipv4", "first": "127.0.0.0", "last": "127.255.255.255"},
        {"address_family": "ipv6",
         "first": "0000:0000:0000:0000:0000:0000:0000:0001",
         "last": "0000:0000:0000:0000:0000:0000:0000:0001"},
        {"address_family": "ipv6",
         "first": "0000:0000:0000:0000:0000:ffff:7f00:0000",
         "last": "0000:0000:0000:0000:0000:ffff:7fff:ffff"}
    ])
}

/// `address_sets.non_loopback` of the v2 descriptor, verbatim.
pub(super) fn non_loopback_ranges() -> Value {
    json!([
        {"address_family": "ipv4", "first": "0.0.0.0", "last": "126.255.255.255"},
        {"address_family": "ipv4", "first": "128.0.0.0", "last": "255.255.255.255"},
        {"address_family": "ipv6",
         "first": "0000:0000:0000:0000:0000:0000:0000:0000",
         "last": "0000:0000:0000:0000:0000:0000:0000:0000"},
        {"address_family": "ipv6",
         "first": "0000:0000:0000:0000:0000:0000:0000:0002",
         "last": "0000:0000:0000:0000:0000:ffff:7eff:ffff"},
        {"address_family": "ipv6",
         "first": "0000:0000:0000:0000:0000:ffff:8000:0000",
         "last": "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"}
    ])
}

pub(super) fn external_rule(tier: &str, account_sid: &str) -> Value {
    json!({
        "action_kind": "create_or_replace",
        "object_key": object_key("external_outbound_block", tier, OWNER),
        "authority": "primary",
        "mechanism": "wfp",
        "rule_class": "external_outbound_block",
        "tier": tier,
        "account_sid": account_sid,
        "action": "block",
        "protocol": "any",
        "address_ranges": non_loopback_ranges(),
        "match_mode": "every_port",
        "blocked_tcp_port_ranges": [],
        "blocked_udp_port_ranges": [],
        "filters": [
            {"layer": "ale_auth_connect_v4", "match": "non_loopback", "transport": "unsplit"},
            {"layer": "ale_auth_connect_v6", "match": "non_loopback", "transport": "unsplit"}
        ]
    })
}

/// A loopback rule whose TCP complement leaves 8787 open and whose UDP complement leaves nothing.
pub(super) fn loopback_rule(tier: &str, account_sid: &str) -> Value {
    let filters: Vec<Value> = ["ale_auth_connect_v4", "ale_auth_connect_v6"]
        .into_iter()
        .flat_map(|layer| {
            ["loopback_flag", "loopback_address"]
                .into_iter()
                .flat_map(move |matched| {
                    ["tcp", "udp", "other_protocols"].into_iter().map(move |transport| {
                        json!({"layer": layer, "match": matched, "transport": transport})
                    })
                })
        })
        .collect();
    json!({
        "action_kind": "create_or_replace",
        "object_key": object_key("loopback_non_allowlisted_block", tier, OWNER),
        "authority": "primary",
        "mechanism": "wfp",
        "rule_class": "loopback_non_allowlisted_block",
        "tier": tier,
        "account_sid": account_sid,
        "action": "block",
        "protocol": "any",
        "address_ranges": loopback_ranges(),
        "match_mode": "block_complement_of_allowed_ports",
        "blocked_tcp_port_ranges": [{"first": 1, "last": 8786}, {"first": 8788, "last": 65535}],
        "blocked_udp_port_ranges": [{"first": 1, "last": 65535}],
        "filters": filters
    })
}

/// `address_sets.internal` of the shipped descriptor, read from it rather than restated.
pub(super) fn internal_ranges() -> Value {
    let bundle: Value = serde_json::from_str(include_str!(
        "../../../../shared/contracts/generated/data/egress-policy-descriptor.json"
    ))
    .expect("the descriptor bundle is JSON");
    bundle["descriptor"]["address_sets"]["internal"].clone()
}

/// The network connector tier's rule: external stays open, the internal ranges are blocked.
pub(super) fn internal_rule(account_sid: &str) -> Value {
    json!({
        "action_kind": "create_or_replace",
        "object_key": object_key("internal_outbound_block", "network_connector", OWNER),
        "authority": "primary",
        "mechanism": "wfp",
        "rule_class": "internal_outbound_block",
        "tier": "network_connector",
        "account_sid": account_sid,
        "action": "block",
        "protocol": "any",
        "address_ranges": internal_ranges(),
        "match_mode": "every_port",
        "blocked_tcp_port_ranges": [],
        "blocked_udp_port_ranges": [],
        "filters": [
            {"layer": "ale_auth_connect_v4", "match": "internal_address", "transport": "unsplit"},
            {"layer": "ale_auth_connect_v6", "match": "internal_address", "transport": "unsplit"}
        ]
    })
}

/// The upstream proxy permit for the given addresses, with one filter per family they have.
pub(super) fn upstream_permit(addresses: &[&str], port: u16) -> Value {
    let layers = ["ale_auth_connect_v4", "ale_auth_connect_v6"]
        .into_iter()
        .filter(|layer| addresses.iter().any(|text| text.contains(':') == layer.ends_with("v6")));
    let filters: Vec<Value> = layers
        .map(|layer| json!({"layer": layer, "match": "upstream_address", "transport": "tcp"}))
        .collect();
    json!({
        "action_kind": "create_or_replace",
        "object_key": object_key("upstream_proxy_permit", "network_connector", OWNER),
        "tier": "network_connector",
        "account_sid": CONNECTOR_SID,
        "action": "permit",
        "protocol": "tcp",
        "addresses": addresses,
        "port": port,
        "additional_ports": [],
        "filters": filters
    })
}

/// `plan` with the given upstream permits.
pub(super) fn with_permits(mut plan: Value, permits: Vec<Value>) -> Value {
    plan["upstream_permits"] = Value::Array(permits);
    plan
}

pub(super) fn removal(class: &str, tier: &str, account_sid: &str) -> Value {
    json!({
        "action_kind": "remove_owned_object",
        "object_key": object_key(class, tier, OWNER),
        "mechanism": "wfp",
        "rule_class": class,
        "tier": tier,
        "account_sid": account_sid
    })
}

/// A whole plan around the given rules and removals.
///
/// The fields the applier does not act on - the label, the boundary state, the tier partition - are
/// filled the way the planner would, so a refusal in a test is about the field the test changed.
pub(super) fn plan(mode: Option<&str>, rules: Vec<Value>, removals: Vec<Value>) -> Value {
    let mut covered: Vec<String> = rules
        .iter()
        .map(|rule| {
            rule["tier"]
                .as_str()
                .expect("a rule names its tier")
                .to_owned()
        })
        .collect();
    covered.sort();
    covered.dedup();
    let uncovered: Vec<&str> = ["bootstrap", "file_tool", "network_connector", "channel"]
        .into_iter()
        .filter(|tier| !covered.iter().any(|covered| covered == tier))
        .collect();
    let installs = !rules.is_empty();
    let tables = wfp_rules().expect("the embedded WFP tables parse");
    let version = tables.policy_version;
    json!({
        "contract_version": tables.contract_version,
        "policy_version": version,
        "policy_version_label": format!("v{version}/permissive"),
        "intent": if installs { "install" } else { "uninstall" },
        "owner_sid": OWNER,
        "boundary_state": if installs {
            "primary_rules_do_not_cover_every_tier"
        } else {
            "removed_by_uninstall"
        },
        "mode": mode,
        "covered_tiers": covered,
        "uncovered_tiers": uncovered,
        "preconditions": [
            {"action_kind": "verify_precondition", "precondition": "base_filtering_engine_running"},
            {"action_kind": "verify_precondition", "precondition": "dynamic_port_range_known"},
            {"action_kind": "verify_precondition",
             "precondition": "declared_ports_outside_dynamic_port_range"},
            {"action_kind": "verify_precondition", "precondition": "sublayer_weight_uncontested"}
        ],
        "primary_rules": rules,
        "supplementary_filters": [],
        "upstream_permits": [],
        "removals": removals,
        "install_sublayer": installs
    })
}

/// The plan the shipped permissive policy produces: the presence anchor, no rule, no mode.
pub(super) fn permissive_plan(removals: Vec<Value>) -> Value {
    let mut anchored = plan(None, vec![], removals);
    anchored["intent"] = json!("install");
    anchored["boundary_state"] = json!("declared_permissive_no_rules");
    anchored["install_sublayer"] = json!(true);
    anchored
}

pub(super) fn by_key(filters: Vec<InstalledFilter>) -> BTreeMap<u128, InstalledFilter> {
    filters
        .into_iter()
        .map(|installed| (installed.filter.key, installed))
        .collect()
}

/// An in-memory filtering engine with WFP's transaction semantics: writes land in a staged copy that a
/// commit publishes and an abort throws away, and adding a key that exists fails as WFP's does.
#[derive(Default)]
pub(super) struct FakeEngine {
    pub filters: BTreeMap<u128, InstalledFilter>,
    pub sublayer: Option<InstalledSublayer>,
    staged: Option<(BTreeMap<u128, InstalledFilter>, Option<InstalledSublayer>)>,
    pub begins: usize,
    pub commits: usize,
    pub aborts: usize,
    pub adds: usize,
    pub deletes: usize,
    pub sublayer_adds: usize,
    /// Fail the filter add with this zero-based index.
    pub fail_add_at: Option<usize>,
    /// Store every sublayer without its tag, so a verify of the sublayer sees a mismatch.
    pub drop_sublayer_tag: bool,
    /// Fail the sublayer add with this zero-based index.
    pub fail_sublayer_add_at: Option<usize>,
    /// Fail the filter delete with this zero-based index.
    pub fail_delete_at: Option<usize>,
    /// Once committed, report this filter with its action flipped.
    pub tamper_on_read: Option<u128>,
    /// Store a sublayer weight of 0xFFFF as 0xFFFE, as the real engine does: it keeps the weight it reads back, not the one it was given.
    pub clamp_max_sublayer_weight: bool,
    /// Refuse to enumerate a sublayer, as the engine does for a caller without the enumerate right.
    pub deny_enumeration: bool,
    /// Report this filter with its action flipped while a transaction is open, so a verify before commit sees it.
    pub tamper_in_transaction: Option<u128>,
    /// Store every sublayer one weight lower than written, so a verify of the sublayer sees a mismatch.
    pub skew_sublayer_weight: bool,
}

impl FakeEngine {
    fn view(
        &mut self,
    ) -> (
        &mut BTreeMap<u128, InstalledFilter>,
        &mut Option<InstalledSublayer>,
    ) {
        match &mut self.staged {
            Some((filters, sublayer)) => (filters, sublayer),
            None => (&mut self.filters, &mut self.sublayer),
        }
    }

    fn require_transaction(&self, what: &str) {
        assert!(self.staged.is_some(), "{what} outside a transaction");
    }
}

impl WfpReader for FakeEngine {
    fn sublayer(&mut self, key: u128) -> io::Result<Option<InstalledSublayer>> {
        let current = self.view().1.clone();
        Ok(current.filter(|sublayer| sublayer.key == key))
    }

    fn filter(&mut self, key: u128) -> io::Result<Option<InstalledFilter>> {
        let tamper = (self.staged.is_none() && self.tamper_on_read == Some(key))
            || (self.staged.is_some() && self.tamper_in_transaction == Some(key));
        let found = self.view().0.get(&key).cloned();
        Ok(found.map(|mut installed| {
            if tamper {
                installed.filter.action = match installed.filter.action {
                    FilterAction::Block => FilterAction::SoftPermit,
                    FilterAction::SoftPermit => FilterAction::Block,
                };
            }
            installed
        }))
    }

    fn filters_in_sublayer(&mut self, sublayer: u128) -> io::Result<Vec<u128>> {
        if self.deny_enumeration {
            return Err(io::Error::from_raw_os_error(5));
        }
        Ok(self
            .view()
            .0
            .values()
            .filter(|installed| installed.sublayer == sublayer)
            .map(|installed| installed.filter.key)
            .collect())
    }

}

impl WfpEngine for FakeEngine {
    fn begin(&mut self) -> io::Result<()> {
        assert!(self.staged.is_none(), "a nested transaction");
        self.begins += 1;
        self.staged = Some((self.filters.clone(), self.sublayer.clone()));
        Ok(())
    }

    fn commit(&mut self) -> io::Result<()> {
        let (filters, sublayer) = self.staged.take().expect("a commit outside a transaction");
        self.commits += 1;
        self.filters = filters;
        self.sublayer = sublayer;
        Ok(())
    }

    fn abort(&mut self) -> io::Result<()> {
        self.staged.take().expect("an abort outside a transaction");
        self.aborts += 1;
        Ok(())
    }

    fn add_sublayer(&mut self, sublayer: &InstalledSublayer) -> io::Result<()> {
        self.require_transaction("a sublayer add");
        let index = self.sublayer_adds;
        self.sublayer_adds += 1;
        if self.fail_sublayer_add_at == Some(index) {
            return Err(io::Error::other("injected sublayer add failure"));
        }
        let mut stored = sublayer.clone();
        if self.drop_sublayer_tag {
            stored.provider_data.clear();
        }
        if self.skew_sublayer_weight {
            stored.weight = stored.weight.wrapping_sub(1);
        }
        if self.clamp_max_sublayer_weight && stored.weight == u16::MAX {
            stored.weight = u16::MAX - 1;
        }
        *self.view().1 = Some(stored);
        Ok(())
    }

    fn add_filter(&mut self, filter: &InstalledFilter) -> io::Result<()> {
        self.require_transaction("a filter add");
        let index = self.adds;
        self.adds += 1;
        if self.fail_add_at == Some(index) {
            return Err(io::Error::other("injected add failure"));
        }
        let filters = self.view().0;
        if filters.contains_key(&filter.filter.key) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "FWP_E_ALREADY_EXISTS",
            ));
        }
        filters.insert(filter.filter.key, filter.clone());
        Ok(())
    }

    fn delete_filter(&mut self, key: u128) -> io::Result<()> {
        self.require_transaction("a filter delete");
        let index = self.deletes;
        self.deletes += 1;
        if self.fail_delete_at == Some(index) {
            return Err(io::Error::other("injected delete failure"));
        }
        self.view()
            .0
            .remove(&key)
            .map(|_| ())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "FWP_E_FILTER_NOT_FOUND"))
    }

    fn delete_sublayer(&mut self, key: u128) -> io::Result<()> {
        self.require_transaction("a sublayer delete");
        let (filters, sublayer) = self.view();
        if filters.values().any(|installed| installed.sublayer == key) {
            return Err(io::Error::other("FWP_E_IN_USE"));
        }
        match sublayer.take_if(|sublayer| sublayer.key == key) {
            Some(_) => Ok(()),
            None => Err(io::Error::new(
                io::ErrorKind::NotFound,
                "FWP_E_SUBLAYER_NOT_FOUND",
            )),
        }
    }
}

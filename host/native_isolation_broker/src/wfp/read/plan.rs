//! An egress plan as the broker receives it: caller input, checked from scratch before anything is
//! written.
//!
//! The planner already holds these invariants, and that is not a reason to skip them here. A plan that
//! names a layer its class may not use, an owner other than the one asking, or an address set that is
//! not its class's would otherwise become a filter, because the applier writes what it is given.

use super::contract::{
    AddressFamily, AddressRange, FilterMatch, Layer, Mode, Protocol, RuleClass, Tier, Transport, WfpRules,
    wfp_rules,
};
use crate::broker_wire::canonical_wire_json;
use crate::sid_win32::canonical_sid;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PortRange {
    pub first: u16,
    pub last: u16,
}

/// One planned object, boundary rule or supplementary filter, with what its filters need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlannedObject {
    pub object_key: String,
    pub class: RuleClass,
    pub tier: Tier,
    pub account_sid: String,
    /// A boundary rule's address set; empty for a supplementary filter.
    pub address_ranges: Vec<AddressRange>,
    pub blocked_tcp_ports: Vec<PortRange>,
    pub blocked_udp_ports: Vec<PortRange>,
    /// A supplementary filter's protocols and ports; empty for a boundary rule.
    pub protocols: Vec<Protocol>,
    pub blocked_ports: Vec<u16>,
    pub filters: Vec<(Layer, FilterMatch, Transport)>,
}

/// One object that must not exist. Its filters are derived from its class, since it lists none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlannedRemoval {
    pub object_key: String,
    pub class: RuleClass,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedWfpPlan {
    pub owner_sid: String,
    pub mode: Option<Mode>,
    pub objects: Vec<PlannedObject>,
    pub removals: Vec<PlannedRemoval>,
    /// The presence anchor: our sublayer must exist, even when no filter is wanted in it.
    pub install_sublayer: bool,
    /// The `providerData` every object this plan installs carries: the contract's prefix and the
    /// plan's digest.
    pub provider_data: Vec<u8>,
}

/// Why a plan was refused before anything was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WfpPlanRefusal {
    /// Not the plan shape, or a plan of another contract or policy version.
    ShapeInvalid,
    /// An object or a removal whose key is not the one its mechanism, class and tier and the plan's
    /// owner derive - in particular, one keyed for another owner.
    ObjectKeyNotDerived,
    /// A rule scoped to an account that cannot be a tier account: the owner, a well-known principal,
    /// or one account named for two tiers.
    AccountNotATierAccount,
    /// A filter at a layer, or with a match or transport, its class may not use.
    FilterNotAllowedForClass,
    /// An object whose filters are not exactly its class's table.
    FilterSetNotTheClassTable,
    /// A boundary rule whose addresses are not its class's address set.
    AddressSetWrongForClass,
    /// A mode on a plan that installs nothing, or none on a plan that installs something.
    ModeInconsistentWithContent,
    /// A plan that installs objects without asking for the sublayer they go into.
    SublayerAbsentForObjects,
    /// A loopback block that opens a port other than the tier's declared services and, as one
    /// whole gap, the contract's dynamic range; or any UDP port. In particular one that opens a host
    /// control port, or only part of the dynamic range, or more than it.
    LoopbackPortsNotTheContract,
}

use WfpPlanRefusal::*;

// The literal fields of the contract, each a one-value enum so that any other value fails to parse.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum CreateOrReplace {
    CreateOrReplace,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RemoveOwnedObject {
    RemoveOwnedObject,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum PrimaryAuthority {
    Primary,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum SupplementaryAuthority {
    Supplementary,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Wfp {
    Wfp,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum BlockAction {
    Block,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum AnyProtocol {
    Any,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum PermitAction {
    Permit,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum TcpProtocol {
    Tcp,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum VerifyPrecondition {
    VerifyPrecondition,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Intent {
    Install,
    Repair,
    Uninstall,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MatchMode {
    EveryPort,
    BlockComplementOfAllowedPorts,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanWire {
    contract_version: u64,
    policy_version: u64,
    policy_version_label: String,
    intent: Intent,
    owner_sid: String,
    boundary_state: String,
    mode: Option<Mode>,
    covered_tiers: Vec<Tier>,
    uncovered_tiers: Vec<Tier>,
    preconditions: Vec<PreconditionWire>,
    primary_rules: Vec<BoundaryRuleWire>,
    supplementary_filters: Vec<SupplementaryWire>,
    upstream_permits: Vec<PermitWire>,
    removals: Vec<RemovalWire>,
    install_sublayer: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreconditionWire {
    action_kind: VerifyPrecondition,
    precondition: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BoundaryRuleWire {
    action_kind: CreateOrReplace,
    object_key: String,
    authority: PrimaryAuthority,
    mechanism: Wfp,
    rule_class: RuleClass,
    tier: Tier,
    account_sid: String,
    action: BlockAction,
    protocol: AnyProtocol,
    address_ranges: Vec<AddressRange>,
    match_mode: MatchMode,
    blocked_tcp_port_ranges: Vec<PortRangeWire>,
    blocked_udp_port_ranges: Vec<PortRangeWire>,
    filters: Vec<FilterWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SupplementaryWire {
    action_kind: CreateOrReplace,
    object_key: String,
    authority: SupplementaryAuthority,
    mechanism: Wfp,
    filter_class: RuleClass,
    tier: Tier,
    account_sid: String,
    action: BlockAction,
    protocols: Vec<Protocol>,
    blocked_ports: Vec<u16>,
    filters: Vec<FilterWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PermitWire {
    action_kind: CreateOrReplace,
    object_key: String,
    tier: Tier,
    account_sid: String,
    action: PermitAction,
    protocol: TcpProtocol,
    addresses: Vec<String>,
    port: u16,
    additional_ports: Vec<u16>,
    filters: Vec<FilterWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemovalWire {
    action_kind: RemoveOwnedObject,
    object_key: String,
    mechanism: Wfp,
    rule_class: RuleClass,
    tier: Tier,
    account_sid: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilterWire {
    layer: Layer,
    #[serde(rename = "match")]
    matched: FilterMatch,
    transport: Transport,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PortRangeWire {
    first: u16,
    last: u16,
}

/// Checks a plan's bytes against the shape and the shipped tables.
pub(crate) fn validate_plan(bytes: &[u8]) -> Result<ValidatedWfpPlan, WfpPlanRefusal> {
    let rules = wfp_rules().map_err(|_| ShapeInvalid)?;
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ShapeInvalid)?;
    let wire: PlanWire = serde_json::from_value(value.clone()).map_err(|_| ShapeInvalid)?;
    if wire.contract_version != rules.contract_version
        || wire.policy_version != rules.policy_version
        || wire.policy_version_label.is_empty()
        || wire.boundary_state.is_empty()
        || !is_sid(&wire.owner_sid)
        || !is_canonical_sid(&wire.owner_sid)
        || wire
            .preconditions
            .iter()
            .any(|step| !rules.required_preconditions.contains(&step.precondition))
    {
        return Err(ShapeInvalid);
    }
    let owner = wire.owner_sid.as_str();
    let mut accounts = Accounts::default();
    let mut loopback_gap: Option<(u32, u32)> = None;
    let mut objects = Vec::new();

    for rule in wire.primary_rules {
        if !rule.rule_class.is_primary() {
            return Err(ShapeInvalid);
        }
        let every_port = rule.match_mode == MatchMode::EveryPort;
        let lists_empty = [&rule.blocked_tcp_port_ranges, &rule.blocked_udp_port_ranges]
            .map(|list| list.is_empty());
        if lists_empty != [every_port, every_port] {
            return Err(ShapeInvalid);
        }
        let object = PlannedObject {
            object_key: rule.object_key,
            class: rule.rule_class,
            tier: rule.tier,
            account_sid: rule.account_sid,
            address_ranges: rule.address_ranges,
            blocked_tcp_ports: port_ranges(rule.blocked_tcp_port_ranges)?,
            blocked_udp_ports: port_ranges(rule.blocked_udp_port_ranges)?,
            protocols: Vec::new(),
            blocked_ports: Vec::new(),
            filters: filters(rule.filters),
        };
        check_object(rules, owner, rule.tier, &object, &mut accounts)?;
        let expected = match object.class {
            RuleClass::ExternalOutboundBlock => &rules.non_loopback_addresses,
            RuleClass::InternalOutboundBlock => &rules.internal_addresses,
            _ => &rules.loopback_addresses,
        };
        if &object.address_ranges != expected {
            return Err(AddressSetWrongForClass);
        }
        if object.class == RuleClass::LoopbackNonAllowlistedBlock {
            if let Some(gap) = check_loopback_ports(rules, rule.tier, &object)? {
                // One host has one dynamic range: every tier that has a gap has the same one.
                if loopback_gap.is_some_and(|earlier| earlier != gap) {
                    return Err(LoopbackPortsNotTheContract);
                }
                loopback_gap = Some(gap);
            }
        }
        objects.push(object);
    }

    for filter in wire.supplementary_filters {
        if filter.filter_class.is_primary()
            || filter.protocols.is_empty()
            || filter.blocked_ports.contains(&0)
        {
            return Err(ShapeInvalid);
        }
        let object = PlannedObject {
            object_key: filter.object_key,
            class: filter.filter_class,
            tier: filter.tier,
            account_sid: filter.account_sid,
            address_ranges: Vec::new(),
            blocked_tcp_ports: Vec::new(),
            blocked_udp_ports: Vec::new(),
            protocols: filter.protocols,
            blocked_ports: filter.blocked_ports,
            filters: filters(filter.filters),
        };
        check_object(rules, owner, filter.tier, &object, &mut accounts)?;
        objects.push(object);
    }

    for permit in wire.upstream_permits {
        if permit.tier != Tier::NetworkConnector
            || permit.port == 0
            || permit.addresses.is_empty()
            || permit.addresses.len() > MAX_UPSTREAM_ADDRESSES
        {
            return Err(ShapeInvalid);
        }
        let ports = permit_ports(permit.port, &permit.additional_ports)?;
        let object = PlannedObject {
            object_key: permit.object_key,
            class: RuleClass::UpstreamProxyPermit,
            tier: permit.tier,
            account_sid: permit.account_sid,
            address_ranges: permit_ranges(&permit.addresses)?,
            blocked_tcp_ports: ports,
            blocked_udp_ports: Vec::new(),
            protocols: Vec::new(),
            blocked_ports: Vec::new(),
            filters: filters(permit.filters),
        };
        check_object(rules, owner, permit.tier, &object, &mut accounts)?;
        objects.push(object);
    }

    let mut keys = BTreeSet::new();
    if !objects
        .iter()
        .all(|object| keys.insert(object.object_key.clone()))
    {
        return Err(ShapeInvalid);
    }
    let mut removals = Vec::new();
    for removal in wire.removals {
        if removal.object_key != object_key(removal.rule_class, removal.tier, owner) {
            return Err(ObjectKeyNotDerived);
        }
        if !is_sid(&removal.account_sid) || !keys.insert(removal.object_key.clone()) {
            return Err(ShapeInvalid);
        }
        removals.push(PlannedRemoval {
            object_key: removal.object_key,
            class: removal.rule_class,
        });
    }

    if wire.mode.is_some() != !objects.is_empty() {
        return Err(ModeInconsistentWithContent);
    }
    if !objects.is_empty() && !wire.install_sublayer {
        return Err(SublayerAbsentForObjects);
    }
    let canonical = canonical_wire_json(&value).map_err(|_| ShapeInvalid)?;
    let digest = hex::encode(Sha256::digest(canonical.as_bytes()));
    let provider_data = format!("{}{digest}", rules.provider_data_prefix).into_bytes();
    Ok(ValidatedWfpPlan {
        owner_sid: wire.owner_sid,
        mode: wire.mode,
        objects,
        removals,
        install_sublayer: wire.install_sublayer,
        provider_data,
    })
}

/// The most addresses one upstream proxy's permit carries.
const MAX_UPSTREAM_ADDRESSES: usize = 8;

/// The most ports beyond `port` a permit carries (EG2-11: the PAC host's and each named proxy's).
const MAX_UPSTREAM_ADDITIONAL_PORTS: usize = 7;

/// A permit's ports as one-port ranges: `port` first, then `additional_ports`, which must be
/// strictly ascending and above it. The one order means one plan has one digest and one readback.
fn permit_ports(port: u16, additional: &[u16]) -> Result<Vec<PortRange>, WfpPlanRefusal> {
    let ascending = std::iter::once(&port)
        .chain(additional)
        .collect::<Vec<_>>()
        .windows(2)
        .all(|pair| pair[0] < pair[1]);
    if additional.len() > MAX_UPSTREAM_ADDITIONAL_PORTS || !ascending {
        return Err(ShapeInvalid);
    }
    Ok(std::iter::once(port)
        .chain(additional.iter().copied())
        .map(|port| PortRange {
            first: port,
            last: port,
        })
        .collect())
}

const V4_MAPPED_PREFIX: &str = "0000:0000:0000:0000:0000:ffff:";

/// A permit's addresses as one-address ranges, each once and in the contract's one spelling: a
/// dotted quad, or eight groups of four lower-case hex digits. Loopback and v4-mapped addresses are
/// refused, since a permit for either would outrank the loopback block. So are the link-local range
/// (the metadata address among it), the unspecified address and multicast: none of them is a proxy.
fn permit_ranges(addresses: &[String]) -> Result<Vec<AddressRange>, WfpPlanRefusal> {
    let mut seen = BTreeSet::new();
    let mut ranges = Vec::new();
    for text in addresses {
        let (family, canonical, unreachable) = if text.contains(':') {
            let parsed: Ipv6Addr = text.parse().map_err(|_| ShapeInvalid)?;
            let groups = parsed.segments().map(|group| format!("{group:04x}"));
            // fe80::/10 is link-local; a permit for it, like one for the metadata address, is no proxy.
            let link_local = parsed.segments()[0] & 0xffc0 == 0xfe80;
            (
                AddressFamily::Ipv6,
                groups.join(":"),
                parsed.is_loopback() || parsed.is_unspecified() || parsed.is_multicast() || link_local,
            )
        } else {
            let parsed: Ipv4Addr = text.parse().map_err(|_| ShapeInvalid)?;
            (
                AddressFamily::Ipv4,
                parsed.to_string(),
                parsed.is_loopback()
                    || parsed.is_unspecified()
                    || parsed.is_multicast()
                    || parsed.is_link_local(),
            )
        };
        if canonical != *text
            || unreachable
            || canonical.starts_with(V4_MAPPED_PREFIX)
            || !seen.insert(canonical.clone())
        {
            return Err(ShapeInvalid);
        }
        ranges.push(AddressRange {
            address_family: family,
            first: canonical.clone(),
            last: canonical,
        });
    }
    Ok(ranges)
}

/// The ports a loopback block leaves open, as inclusive ranges: the complement of what it blocks.
fn open_ports(blocked: &[PortRange]) -> Vec<(u32, u32)> {
    let mut sorted: Vec<_> = blocked
        .iter()
        .map(|range| (u32::from(range.first), u32::from(range.last)))
        .collect();
    sorted.sort_unstable();
    let mut open = Vec::new();
    let mut cursor = 1_u32;
    for (first, last) in sorted {
        if first > cursor {
            open.push((cursor, first - 1));
        }
        cursor = cursor.max(last + 1);
    }
    if cursor <= u32::from(u16::MAX) {
        open.push((cursor, u32::from(u16::MAX)));
    }
    open
}

/// A loopback block's gaps are the tier's declared services and, all or none of it, one gap that is
/// the host's dynamic range (CPython's socketpair); UDP has none.
///
/// The gap is accepted only if it is one contiguous range that is sane by the contract's bounds and
/// contains no port a declared loopback endpoint may listen on (a host control port among them). A
/// gap that is split, too small, reaches below `min_first`, or takes in such a port is refused, so the
/// one hole the contract admits cannot be widened by a plan. Returns the gap, if the tier has one.
fn check_loopback_ports(
    rules: &WfpRules,
    tier: Tier,
    object: &PlannedObject,
) -> Result<Option<(u32, u32)>, WfpPlanRefusal> {
    if !open_ports(&object.blocked_udp_ports).is_empty() {
        return Err(LoopbackPortsNotTheContract);
    }
    let declared = rules.reachable_loopback_ports.get(&tier);
    let mut gap: Option<(u32, u32)> = None;
    for (first, last) in open_ports(&object.blocked_tcp_ports) {
        for port in first..=last {
            if u16::try_from(port).is_ok_and(|port| declared.is_some_and(|set| set.contains(&port)))
            {
                continue;
            }
            gap = match gap {
                None => Some((port, port)),
                Some((start, end)) if end + 1 == port => Some((start, port)),
                Some(_) => return Err(LoopbackPortsNotTheContract),
            };
        }
    }
    let Some((first, last)) = gap else {
        return Ok(None);
    };
    let bounds = &rules.loopback_dynamic_port_range_bounds;
    let sane = first >= u32::from(bounds.min_first)
        && last <= u32::from(bounds.max_last)
        && last - first + 1 >= bounds.min_count;
    let covers_blocked_port = rules
        .loopback_dynamic_range_blocked_ports
        .iter()
        .any(|port| (first..=last).contains(&u32::from(*port)));
    if !sane || covers_blocked_port {
        return Err(LoopbackPortsNotTheContract);
    }
    Ok(Some((first, last)))
}

/// The key `egressObjectKey` builds for a WFP object of this owner.
fn object_key(class: RuleClass, tier: Tier, owner: &str) -> String {
    format!(
        "openwork-egress.wfp.{}.{}.{owner}",
        class.as_str(),
        tier.as_str()
    )
}

fn filters(wire: Vec<FilterWire>) -> Vec<(Layer, FilterMatch, Transport)> {
    wire.into_iter()
        .map(|filter| (filter.layer, filter.matched, filter.transport))
        .collect()
}

fn port_ranges(wire: Vec<PortRangeWire>) -> Result<Vec<PortRange>, WfpPlanRefusal> {
    wire.into_iter()
        .map(|range| {
            if range.first == 0 || range.first > range.last {
                return Err(ShapeInvalid);
            }
            Ok(PortRange {
                first: range.first,
                last: range.last,
            })
        })
        .collect()
}

/// Which account each tier's rules are scoped to, so one account cannot stand for two tiers.
#[derive(Default)]
struct Accounts {
    by_tier: BTreeMap<Tier, String>,
}

impl Accounts {
    fn record(&mut self, tier: Tier, account: &str) -> Result<(), WfpPlanRefusal> {
        if self
            .by_tier
            .iter()
            .any(|(other, named)| (*other == tier) != (named == account))
        {
            return Err(AccountNotATierAccount);
        }
        self.by_tier.insert(tier, account.to_owned());
        Ok(())
    }
}

fn check_object(
    rules: &WfpRules,
    owner: &str,
    tier: Tier,
    object: &PlannedObject,
    accounts: &mut Accounts,
) -> Result<(), WfpPlanRefusal> {
    if object.object_key != object_key(object.class, tier, owner) {
        return Err(ObjectKeyNotDerived);
    }
    if !is_canonical_sid(&object.account_sid)
        || object.account_sid == owner
        || !is_local_account_sid(&object.account_sid)
    {
        return Err(AccountNotATierAccount);
    }
    accounts.record(tier, &object.account_sid)?;
    // A permit has a filter for each family its addresses have and none for a family they lack,
    // because one with no address condition would open the port to every destination.
    let table: Vec<_> = rules
        .filters_for(object.class)
        .into_iter()
        .filter(|(layer, ..)| {
            object.class != RuleClass::UpstreamProxyPermit
                || object
                    .address_ranges
                    .iter()
                    .any(|range| range.address_family == layer.family())
        })
        .collect();
    if object.filters.iter().any(|filter| !table.contains(filter)) {
        return Err(FilterNotAllowedForClass);
    }
    let listed: BTreeSet<_> = object.filters.iter().collect();
    if listed.len() != object.filters.len() || listed != table.iter().collect::<BTreeSet<_>>() {
        return Err(FilterSetNotTheClassTable);
    }
    Ok(())
}

/// `S-1-` followed by at least two numeric components, as the contract's SID pattern states.
fn is_sid(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("S-1-") else {
        return false;
    };
    let parts: Vec<&str> = rest.split('-').collect();
    text.len() <= 184
        && parts.len() >= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

/// Whether `text` is the spelling Windows itself gives the SID. Every account comparison here is on text, and
/// another spelling of one principal (a zero-padded RID, say) would compare unequal to it.
fn is_canonical_sid(text: &str) -> bool {
    canonical_sid(text).is_ok_and(|canonical| canonical == text)
}

/// A local or domain account: `S-1-5-21`, three sub-authorities and a RID of at least 1000, which is
/// where Windows starts numbering accounts it did not create itself. Every well-known principal and
/// every built-in account falls outside it.
fn is_local_account_sid(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("S-1-5-21-") else {
        return false;
    };
    let parts: Vec<Option<u32>> = rest.split('-').map(|part| part.parse().ok()).collect();
    is_sid(text)
        && parts.len() == 4
        && parts.iter().all(Option::is_some)
        && parts[3].is_some_and(|rid| rid >= 1000)
}

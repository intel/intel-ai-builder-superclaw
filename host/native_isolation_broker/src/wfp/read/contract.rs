//! The WFP tables the shipped egress descriptor publishes, embedded rather than restated.
//!
//! Which layers a rule class may be written at, which filters it needs at each, the layer GUIDs, the
//! sublayer and the key derivation's domain all come from `rules.wfp_*` in the generated descriptor
//! bundle, the same data the Python planner and the unelevated readback read. A second copy here would
//! agree with the first until somebody regenerated one of them.

use super::key::parse_key;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::OnceLock;

const DESCRIPTOR_BUNDLE_JSON: &str =
    include_str!("../../../../../shared/contracts/generated/data/egress-policy-descriptor.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Layer {
    AleAuthConnectV4,
    AleAuthConnectV6,
    AleResourceAssignmentV4,
    AleResourceAssignmentV6,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AddressFamily {
    Ipv4,
    Ipv6,
}

impl Layer {
    /// The contract's spelling, which is also an input to every filter key.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::AleAuthConnectV4 => "ale_auth_connect_v4",
            Self::AleAuthConnectV6 => "ale_auth_connect_v6",
            Self::AleResourceAssignmentV4 => "ale_resource_assignment_v4",
            Self::AleResourceAssignmentV6 => "ale_resource_assignment_v6",
        }
    }

    pub(crate) fn family(self) -> AddressFamily {
        match self {
            Self::AleAuthConnectV4 | Self::AleResourceAssignmentV4 => AddressFamily::Ipv4,
            Self::AleAuthConnectV6 | Self::AleResourceAssignmentV6 => AddressFamily::Ipv6,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FilterMatch {
    LoopbackFlag,
    LoopbackAddress,
    NonLoopback,
    AnyAddress,
    InternalAddress,
    UpstreamAddress,
}

impl FilterMatch {
    /// The contract's spelling, which is also an input to every filter key.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::LoopbackFlag => "loopback_flag",
            Self::LoopbackAddress => "loopback_address",
            Self::NonLoopback => "non_loopback",
            Self::AnyAddress => "any_address",
            Self::InternalAddress => "internal_address",
            Self::UpstreamAddress => "upstream_address",
        }
    }
}

/// Which protocols one filter matches, and where its port condition comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Transport {
    Tcp,
    Udp,
    OtherProtocols,
    Unsplit,
}

impl Transport {
    /// The contract's spelling, which is also an input to every filter key.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Tcp => "tcp",
            Self::Udp => "udp",
            Self::OtherProtocols => "other_protocols",
            Self::Unsplit => "unsplit",
        }
    }
}

// Spelled as the contract's class names, every one of which ends in `_block`.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuleClass {
    ExternalOutboundBlock,
    LoopbackNonAllowlistedBlock,
    InternalOutboundBlock,
    UpstreamProxyPermit,
    IcmpConnectBlock,
    IcmpResourceAssignmentBlock,
    NameResolutionPortBlock,
    FileSharingPortBlock,
}

impl RuleClass {
    /// The contract's spelling, which is also a segment of every object key.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ExternalOutboundBlock => "external_outbound_block",
            Self::LoopbackNonAllowlistedBlock => "loopback_non_allowlisted_block",
            Self::InternalOutboundBlock => "internal_outbound_block",
            Self::UpstreamProxyPermit => "upstream_proxy_permit",
            Self::IcmpConnectBlock => "icmp_connect_block",
            Self::IcmpResourceAssignmentBlock => "icmp_resource_assignment_block",
            Self::NameResolutionPortBlock => "name_resolution_port_block",
            Self::FileSharingPortBlock => "file_sharing_port_block",
        }
    }

    /// Whether the class belongs to the boundary rather than to the supplementary layer.
    pub(crate) fn is_primary(self) -> bool {
        matches!(
            self,
            Self::ExternalOutboundBlock
                | Self::LoopbackNonAllowlistedBlock
                | Self::InternalOutboundBlock
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Tier {
    Bootstrap,
    FileTool,
    NetworkConnector,
    Channel,
}

impl Tier {
    pub(crate) const ALL: [Self; 4] = [
        Self::Bootstrap,
        Self::FileTool,
        Self::NetworkConnector,
        Self::Channel,
    ];

    /// The contract's spelling, which is also a segment of every object key.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::FileTool => "file_tool",
            Self::NetworkConnector => "network_connector",
            Self::Channel => "channel",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Mode {
    LogOnly,
    Enforce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Protocol {
    Any,
    Tcp,
    Udp,
    Icmpv4,
    Icmpv6,
}

impl Protocol {
    /// The IP protocol number, or `None` for the wildcard.
    pub(crate) fn number(self) -> Option<u8> {
        match self {
            Self::Any => None,
            Self::Tcp => Some(6),
            Self::Udp => Some(17),
            Self::Icmpv4 => Some(1),
            Self::Icmpv6 => Some(58),
        }
    }
}

/// One inclusive address range in the contract's canonical spelling.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AddressRange {
    pub address_family: AddressFamily,
    pub first: String,
    pub last: String,
}

/// Everything the applier takes from the shipped descriptor.
#[derive(Debug)]
pub(crate) struct WfpRules {
    pub contract_version: u64,
    pub policy_version: u64,
    pub layer_keys: BTreeMap<Layer, u128>,
    pub layers_by_class: BTreeMap<RuleClass, Vec<Layer>>,
    pub filters_by_class: BTreeMap<RuleClass, Vec<(FilterMatch, Transport)>>,
    pub other_protocol_ranges: Vec<(u8, u8)>,
    pub sublayer_key: u128,
    pub sublayer_weight: u16,
    pub filter_key_domain: String,
    pub provider_data_prefix: String,
    pub required_preconditions: Vec<String>,
    pub loopback_addresses: Vec<AddressRange>,
    pub non_loopback_addresses: Vec<AddressRange>,
    pub internal_addresses: Vec<AddressRange>,
    /// What a host's dynamic range must satisfy to be the one loopback gap every tier's loopback block
    /// may leave open (egress-loopback-dynamic-range.ts): it starts at or above `min_first`, ends at or
    /// below `max_last`, and holds at least `min_count` ports.
    pub loopback_dynamic_port_range_bounds: DynamicPortRangeBounds,
    /// Every port a declared loopback endpoint may listen on; no gap may contain one.
    pub loopback_dynamic_range_blocked_ports: BTreeSet<u16>,
    /// The loopback ports each tier's services listen on, which its loopback block may leave open.
    pub reachable_loopback_ports: BTreeMap<Tier, BTreeSet<u16>>,
    /// Each class's weight inside the sublayer; a permit outranks the block it opens.
    pub weights: BTreeMap<RuleClass, u8>,
}

impl WfpRules {
    /// Every filter a class is written as, by layer, match and transport, in table order.
    pub(crate) fn filters_for(&self, class: RuleClass) -> Vec<(Layer, FilterMatch, Transport)> {
        let layers = self
            .layers_by_class
            .get(&class)
            .map_or(&[][..], Vec::as_slice);
        let shapes = self
            .filters_by_class
            .get(&class)
            .map_or(&[][..], Vec::as_slice);
        layers
            .iter()
            .flat_map(|&layer| {
                shapes
                    .iter()
                    .map(move |&(matched, transport)| (layer, matched, transport))
            })
            .collect()
    }
}

#[derive(Deserialize)]
struct Bundle {
    contract_version: u64,
    descriptor: DescriptorPart,
    rules: RulesPart,
}

#[derive(Deserialize)]
struct DescriptorPart {
    policy_version: u64,
    address_sets: AddressSets,
    loopback_endpoints: Vec<LoopbackEndpoint>,
}

#[derive(Deserialize)]
struct LoopbackEndpoint {
    ports: Vec<u16>,
    loopback_disposition: String,
    reachable_from: Vec<Tier>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DynamicPortRangeBounds {
    pub min_first: u16,
    pub max_last: u16,
    pub min_count: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AddressSets {
    loopback: Vec<AddressRange>,
    non_loopback: Vec<AddressRange>,
    internal: Vec<AddressRange>,
}

#[derive(Deserialize)]
struct RulesPart {
    wfp_layer_keys: BTreeMap<Layer, String>,
    wfp_layers_by_class: BTreeMap<RuleClass, Vec<Layer>>,
    wfp_filters_by_class: BTreeMap<RuleClass, Vec<FilterShape>>,
    wfp_other_protocol_ranges: Vec<ProtocolRange>,
    wfp_sublayer_key: String,
    wfp_sublayer_weight: u16,
    wfp_weights: BTreeMap<RuleClass, u8>,
    wfp_filter_key_domain: String,
    wfp_provider_data_prefix: String,
    required_preconditions: Vec<String>,
    loopback_disposition_allows_reach: BTreeMap<String, bool>,
    loopback_dynamic_port_range_bounds: DynamicPortRangeBounds,
    loopback_dynamic_range_blocked_ports: BTreeSet<u16>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilterShape {
    #[serde(rename = "match")]
    matched: FilterMatch,
    transport: Transport,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolRange {
    first: u8,
    last: u8,
}

/// The embedded tables, parsed once.
///
/// A failure here is a build that embedded a descriptor this code cannot read, so it is reported the
/// same way every time it is asked for rather than retried.
pub(crate) fn wfp_rules() -> io::Result<&'static WfpRules> {
    static RULES: OnceLock<Result<WfpRules, String>> = OnceLock::new();
    match RULES.get_or_init(load) {
        Ok(rules) => Ok(rules),
        Err(message) => Err(io::Error::new(io::ErrorKind::InvalidData, message.clone())),
    }
}

fn load() -> Result<WfpRules, String> {
    let bundle: Bundle = serde_json::from_str(DESCRIPTOR_BUNDLE_JSON)
        .map_err(|error| format!("the embedded egress descriptor does not parse: {error}"))?;
    let rules = bundle.rules;
    let key = |text: &str| parse_key(text).map_err(|error| error.to_string());
    let layer_keys = rules
        .wfp_layer_keys
        .iter()
        .map(|(layer, text)| Ok((*layer, key(text)?)))
        .collect::<Result<_, String>>()?;
    let filters_by_class = rules
        .wfp_filters_by_class
        .into_iter()
        .map(|(class, shapes)| {
            let shapes = shapes
                .into_iter()
                .map(|shape| (shape.matched, shape.transport))
                .collect();
            (class, shapes)
        })
        .collect();
    let other_protocol_ranges = rules
        .wfp_other_protocol_ranges
        .into_iter()
        .map(|range| (range.first, range.last))
        .collect();
    let mut reachable_loopback_ports: BTreeMap<Tier, BTreeSet<u16>> = BTreeMap::new();
    for endpoint in &bundle.descriptor.loopback_endpoints {
        let reaches = rules
            .loopback_disposition_allows_reach
            .get(&endpoint.loopback_disposition)
            .copied()
            .unwrap_or(false);
        if reaches {
            for &tier in &endpoint.reachable_from {
                reachable_loopback_ports
                    .entry(tier)
                    .or_default()
                    .extend(endpoint.ports.iter().copied());
            }
        }
    }
    Ok(WfpRules {
        contract_version: bundle.contract_version,
        policy_version: bundle.descriptor.policy_version,
        layer_keys,
        layers_by_class: rules.wfp_layers_by_class,
        filters_by_class,
        other_protocol_ranges,
        sublayer_key: key(&rules.wfp_sublayer_key)?,
        sublayer_weight: rules.wfp_sublayer_weight,
        filter_key_domain: rules.wfp_filter_key_domain,
        provider_data_prefix: rules.wfp_provider_data_prefix,
        required_preconditions: rules.required_preconditions,
        loopback_addresses: bundle.descriptor.address_sets.loopback,
        non_loopback_addresses: bundle.descriptor.address_sets.non_loopback,
        internal_addresses: bundle.descriptor.address_sets.internal,
        loopback_dynamic_port_range_bounds: rules.loopback_dynamic_port_range_bounds,
        loopback_dynamic_range_blocked_ports: rules.loopback_dynamic_range_blocked_ports,
        reachable_loopback_ports,
        weights: rules.wfp_weights,
    })
}

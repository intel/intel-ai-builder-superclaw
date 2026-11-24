//! The WFP filters a validated plan names, as plain data: what `apply` writes and what a readback has
//! to find.
//!
//! Conditions on one field are ORed and conditions on different fields are ANDed, which is WFP's own
//! rule, so each variant below is one field and carries every value that field matches.

use super::contract::{
    AddressFamily, AddressRange, FilterMatch, Layer, Mode, RuleClass, Transport, wfp_rules,
};
use super::key::filter_key;
use super::plan::{PortRange, ValidatedWfpPlan};
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};

const IPPROTO_TCP: u8 = 6;
const IPPROTO_UDP: u8 = 17;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FilterAction {
    Block,
    /// A permit that leaves the action right set, so every block anywhere still wins. What `log_only`
    /// writes: traffic is unchanged and each hit shows up against our filter.
    SoftPermit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Condition {
    /// `FWPM_CONDITION_ALE_USER_ID`: the connecting token is this account's.
    User(String),
    /// `FWPM_CONDITION_FLAGS` against `FWP_CONDITION_FLAG_IS_LOOPBACK`: all set when `true`, none set
    /// when `false`.
    LoopbackFlag(bool),
    /// `FWPM_CONDITION_IP_REMOTE_ADDRESS` ranges at an IPv4 layer.
    RemoteV4(Vec<(u32, u32)>),
    /// `FWPM_CONDITION_IP_REMOTE_ADDRESS` ranges at an IPv6 layer.
    RemoteV6(Vec<(u128, u128)>),
    /// `FWPM_CONDITION_IP_PROTOCOL` ranges; a single protocol is a range of one.
    Protocol(Vec<(u8, u8)>),
    /// `FWPM_CONDITION_IP_REMOTE_PORT` ranges.
    RemotePort(Vec<(u16, u16)>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DesiredFilter {
    pub key: u128,
    pub layer: Layer,
    /// In a fixed order - user, loopback flag, address, protocol, port - so two descriptions of one
    /// filter compare equal.
    pub conditions: Vec<Condition>,
    pub action: FilterAction,
    /// The class's weight inside the sublayer, so a permit is evaluated before the block it opens.
    pub weight: u8,
}

/// Every filter the plan's objects name, in plan order.
pub(crate) fn desired_filters(plan: &ValidatedWfpPlan) -> io::Result<Vec<DesiredFilter>> {
    let rules = wfp_rules()?;
    let blocks = match plan.mode {
        Some(Mode::Enforce) => FilterAction::Block,
        Some(Mode::LogOnly) => FilterAction::SoftPermit,
        None => return Ok(Vec::new()),
    };
    let mut filters = Vec::new();
    for object in &plan.objects {
        // The upstream permit permits in both modes; it is the one class that is not a block.
        let action = if object.class == RuleClass::UpstreamProxyPermit {
            FilterAction::SoftPermit
        } else {
            blocks
        };
        let weight = *rules
            .weights
            .get(&object.class)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "a class has no weight"))?;
        for &(layer, matched, transport) in &object.filters {
            let mut conditions = vec![Condition::User(object.account_sid.clone())];
            match matched {
                FilterMatch::LoopbackFlag => conditions.push(Condition::LoopbackFlag(true)),
                FilterMatch::LoopbackAddress => {
                    conditions.push(remote_addresses(&object.address_ranges, layer)?);
                }
                FilterMatch::NonLoopback => {
                    conditions.push(Condition::LoopbackFlag(false));
                    conditions.push(remote_addresses(&object.address_ranges, layer)?);
                }
                FilterMatch::InternalAddress | FilterMatch::UpstreamAddress => {
                    conditions.push(remote_addresses(&object.address_ranges, layer)?);
                }
                FilterMatch::AnyAddress => {}
            }
            match transport {
                Transport::Tcp => {
                    one_transport(&mut conditions, IPPROTO_TCP, &object.blocked_tcp_ports);
                }
                Transport::Udp => {
                    one_transport(&mut conditions, IPPROTO_UDP, &object.blocked_udp_ports);
                }
                Transport::OtherProtocols => {
                    conditions.push(Condition::Protocol(rules.other_protocol_ranges.clone()));
                }
                Transport::Unsplit => {
                    // `any` among the protocols is the wildcard, which is no protocol condition at all.
                    let numbers: Option<Vec<u8>> = object
                        .protocols
                        .iter()
                        .map(|protocol| protocol.number())
                        .collect();
                    if let Some(numbers) = numbers.filter(|numbers| !numbers.is_empty()) {
                        conditions.push(Condition::Protocol(
                            numbers.into_iter().map(|number| (number, number)).collect(),
                        ));
                    }
                    if !object.blocked_ports.is_empty() {
                        conditions.push(Condition::RemotePort(
                            object
                                .blocked_ports
                                .iter()
                                .map(|&port| (port, port))
                                .collect(),
                        ));
                    }
                }
            }
            sort_like_the_reader(&mut conditions);
            filters.push(DesiredFilter {
                key: filter_key(rules, &object.object_key, layer, matched, transport),
                layer,
                conditions,
                action,
                weight,
            });
        }
    }
    Ok(filters)
}

/// `engine::read_conditions` returns every range list sorted, so a filter is compared with what was
/// written only if its own lists are sorted the same way, whatever order the plan listed them in.
fn sort_like_the_reader(conditions: &mut [Condition]) {
    for condition in conditions {
        match condition {
            Condition::RemoteV4(ranges) => ranges.sort_unstable(),
            Condition::RemoteV6(ranges) => ranges.sort_unstable(),
            Condition::Protocol(ranges) => ranges.sort_unstable(),
            Condition::RemotePort(ranges) => ranges.sort_unstable(),
            Condition::User(_) | Condition::LoopbackFlag(_) => {}
        }
    }
}

/// One transport, and the ports its own complement blocks. No ports means every port.
fn one_transport(conditions: &mut Vec<Condition>, protocol: u8, ports: &[PortRange]) {
    conditions.push(Condition::Protocol(vec![(protocol, protocol)]));
    if !ports.is_empty() {
        conditions.push(Condition::RemotePort(
            ports
                .iter()
                .map(|range| (range.first, range.last))
                .collect(),
        ));
    }
}

/// The ranges of the layer's own address family, as numbers.
fn remote_addresses(ranges: &[AddressRange], layer: Layer) -> io::Result<Condition> {
    let invalid = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "an address range does not parse",
        )
    };
    let family = layer.family();
    let own = ranges.iter().filter(|range| range.address_family == family);
    let condition = match family {
        AddressFamily::Ipv4 => Condition::RemoteV4(
            own.map(|range| {
                let first: Ipv4Addr = range.first.parse().map_err(|_| invalid())?;
                let last: Ipv4Addr = range.last.parse().map_err(|_| invalid())?;
                Ok((u32::from(first), u32::from(last)))
            })
            .collect::<io::Result<_>>()?,
        ),
        AddressFamily::Ipv6 => Condition::RemoteV6(
            own.map(|range| {
                let first: Ipv6Addr = range.first.parse().map_err(|_| invalid())?;
                let last: Ipv6Addr = range.last.parse().map_err(|_| invalid())?;
                Ok((u128::from(first), u128::from(last)))
            })
            .collect::<io::Result<_>>()?,
        ),
    };
    match &condition {
        Condition::RemoteV4(values) if values.is_empty() => Err(invalid()),
        Condition::RemoteV6(values) if values.is_empty() => Err(invalid()),
        _ => Ok(condition),
    }
}

//! ServiceHub's loopback port: the first usable of the contract's fixed candidates (#51).
//!
//! The desktop shell starts ServiceHub, so the shell picks its port. A dynamic port is one D2 lets
//! every restricted tier reach, so the port comes from `host_service_port_candidates.service_hub`
//! in the egress loopback port contract, tried in order. Four unusable candidates are a refusal in
//! the contract's shape (`EgressPortAllocationRefusal` with `placeholder: "service_hub"`), never a
//! random port.

use std::collections::HashSet;
use std::io::ErrorKind;
use std::net::{Ipv4Addr, TcpListener};
use std::ops::RangeInclusive;

/// The contract's generated port data, embedded the way the broker embeds its startup catalog.
const LOOPBACK_PORT_RULES: &str =
    include_str!("../../../../../shared/contracts/generated/data/egress-loopback-ports.json");

/// Why one candidate cannot be used, in the contract's closed vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unavailable {
    InUse,
    BindAccessDenied,
    InsideDynamicPortRange,
}

impl Unavailable {
    fn as_contract_str(self) -> &'static str {
        match self {
            Self::InUse => "in_use",
            Self::BindAccessDenied => "bind_access_denied",
            Self::InsideDynamicPortRange => "inside_dynamic_port_range",
        }
    }
}

/// Every candidate was unusable: each is listed with its reason, in the order it was tried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PortRefusal {
    pub(crate) candidates: Vec<(u16, Unavailable)>,
}

impl PortRefusal {
    /// The refusal as an `EgressPortAllocationRefusal` document.
    pub(crate) fn to_contract_json(&self) -> serde_json::Value {
        let candidates: Vec<serde_json::Value> = self
            .candidates
            .iter()
            .map(|(port, why)| {
                serde_json::json!({"port": port, "unavailable_because": why.as_contract_str()})
            })
            .collect();
        serde_json::json!({
            "contract_version": rules()["contract_version"],
            "reason": "fixed_port_candidates_unavailable",
            "placeholder": "service_hub",
            "candidates": candidates,
        })
    }
}

fn rules() -> serde_json::Value {
    serde_json::from_str(LOOPBACK_PORT_RULES).expect("the generated port data is JSON")
}

/// ServiceHub's candidates, in the order they are tried.
pub(crate) fn service_hub_candidates() -> Vec<u16> {
    rules()["host_service_port_candidates"]["service_hub"]
        .as_array()
        .expect("the contract publishes ServiceHub's candidates")
        .iter()
        .map(|port| {
            port.as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .expect("every candidate is a TCP port")
        })
        .collect()
}

/// The port the next ServiceHub start listens on. Every start selects again, so a retry after a
/// candidate was taken moves on to the next one.
pub(crate) fn select_service_hub_port() -> Result<u16, String> {
    let dynamic_range = tcp_dynamic_port_range()?;
    let listening = listening_tcp_ports()?;
    select_port(&service_hub_candidates(), |port| {
        candidate_unavailable_because(port, &dynamic_range, &listening)
    })
    .map_err(|refusal| {
        format!(
            "no fixed ServiceHub port is usable: {}",
            refusal.to_contract_json()
        )
    })
}

/// The first candidate `unavailable` has no reason against.
pub(crate) fn select_port(
    candidates: &[u16],
    mut unavailable: impl FnMut(u16) -> Option<Unavailable>,
) -> Result<u16, PortRefusal> {
    let mut refused = Vec::with_capacity(candidates.len());
    for &port in candidates {
        match unavailable(port) {
            None => return Ok(port),
            Some(why) => refused.push((port, why)),
        }
    }
    Err(PortRefusal {
        candidates: refused,
    })
}

/// Why `port` cannot be used, or `None` when it can.
///
/// Nothing here binds or listens on a non-loopback address: a wildcard bind raises the Windows
/// Firewall prompt and briefly opens the port on external interfaces. A listener on any address,
/// the wildcard included, is read from `listening` (the OS listening table) instead, because a
/// plain wildcard listener does not stop a loopback bind on Windows. The table says `in_use`; the
/// one loopback bind then reports a port the table cannot explain, an exclusive holder or a
/// host-reserved range, as `bind_access_denied`.
pub(crate) fn candidate_unavailable_because(
    port: u16,
    dynamic_range: &RangeInclusive<u16>,
    listening: &HashSet<u16>,
) -> Option<Unavailable> {
    if dynamic_range.contains(&port) {
        return Some(Unavailable::InsideDynamicPortRange);
    }
    if listening.contains(&port) {
        return Some(Unavailable::InUse);
    }
    match TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
        Ok(_probe) => None,
        Err(error) if error.kind() == ErrorKind::AddrInUse => Some(Unavailable::InUse),
        Err(_) => Some(Unavailable::BindAccessDenied),
    }
}

/// Every local TCP port with a listener on any address, IPv4 and IPv6, from the OS table.
///
/// `GetExtendedTcpTable` is read-only. Off Windows there is no such table and the set is empty,
/// which leaves the loopback bind as the only probe.
#[cfg(windows)]
pub(crate) fn listening_tcp_ports() -> Result<HashSet<u16>, String> {
    use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};

    // MIB_TCPROW_OWNER_PID is 24 bytes and MIB_TCP6ROW_OWNER_PID is 56; the port is network order.
    let layouts: [(u32, usize, usize); 2] = [(AF_INET as u32, 24, 8), (AF_INET6 as u32, 56, 20)];
    let mut ports = HashSet::new();
    for (family, row_size, port_offset) in layouts {
        let mut size: u32 = 0;
        let mut buffer: Vec<u8> = Vec::new();
        let mut status = ERROR_INSUFFICIENT_BUFFER;
        for _ in 0..5 {
            // SAFETY: the buffer is `size` bytes long, as the call is told, and lives across the call.
            status = unsafe {
                GetExtendedTcpTable(
                    if buffer.is_empty() {
                        std::ptr::null_mut()
                    } else {
                        buffer.as_mut_ptr().cast()
                    },
                    &mut size,
                    0,
                    family,
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                )
            };
            if status != ERROR_INSUFFICIENT_BUFFER {
                break;
            }
            buffer = vec![0u8; size as usize];
        }
        if status != NO_ERROR {
            return Err(format!(
                "the OS listening table could not be read: error {status}"
            ));
        }
        let count = u32::from_le_bytes(buffer[0..4].try_into().expect("four bytes")) as usize;
        for index in 0..count {
            let at = 4 + index * row_size + port_offset;
            let raw = u32::from_le_bytes(buffer[at..at + 4].try_into().expect("four bytes"));
            ports.insert((((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF)) as u16);
        }
    }
    Ok(ports)
}

#[cfg(not(windows))]
pub(crate) fn listening_tcp_ports() -> Result<HashSet<u16>, String> {
    Ok(HashSet::new())
}

/// The host's TCP dynamic port range, read from `netsh` each time it is asked.
#[cfg(windows)]
pub(crate) fn tcp_dynamic_port_range() -> Result<RangeInclusive<u16>, String> {
    use std::path::PathBuf;
    use std::process::Command;

    let netsh = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("netsh.exe");
    let mut command = Command::new(netsh);
    command.args(["interface", "ipv4", "show", "dynamicport", "tcp"]);
    crate::platform::configure_hidden(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("the TCP dynamic port range could not be read: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "the TCP dynamic port range could not be read: netsh exited with {}",
            output.status
        ));
    }
    parse_dynamic_port_range(&String::from_utf8_lossy(&output.stdout))
}

/// Off Windows there is no `netsh` and the candidates sit below every default dynamic range, so
/// the range is empty and the loopback bind stays the only probe.
#[cfg(not(windows))]
#[allow(clippy::reversed_empty_ranges)]
pub(crate) fn tcp_dynamic_port_range() -> Result<RangeInclusive<u16>, String> {
    Ok(1..=0)
}

/// The range in one `netsh interface ipv4 show dynamicport tcp` output.
///
/// The labels are localized, so the start port and the port count are the last number on each of
/// the first two lines after the rule.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn parse_dynamic_port_range(text: &str) -> Result<RangeInclusive<u16>, String> {
    let unreadable = || format!("unrecognised dynamic port range output: {text:?}");
    let (_, after_rule) = text.split_once("---").ok_or_else(unreadable)?;
    let values: Vec<u32> = after_rule
        .lines()
        .filter(|line| !line.trim().trim_matches('-').is_empty())
        .take(2)
        .map(|line| {
            line.split(|c: char| !c.is_ascii_digit())
                .filter(|digits| !digits.is_empty())
                .last()
                .and_then(|digits| digits.parse().ok())
        })
        .collect::<Option<_>>()
        .ok_or_else(unreadable)?;
    let [start, count] = values[..] else {
        return Err(unreadable());
    };
    let end = start.checked_add(count).and_then(|end| end.checked_sub(1));
    match (u16::try_from(start), end.map(u16::try_from)) {
        (Ok(start), Some(Ok(end))) if start > 0 && count > 0 => Ok(start..=end),
        _ => Err(unreadable()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn contract() -> serde_json::Value {
        serde_json::from_str(LOOPBACK_PORT_RULES).expect("the generated port data is JSON")
    }

    /// A range no port is inside, so a probe test exercises the binds alone.
    #[allow(clippy::reversed_empty_ranges)]
    fn no_dynamic_range() -> RangeInclusive<u16> {
        1..=0
    }

    #[cfg(not(windows))]
    #[test]
    fn off_windows_the_dynamic_range_is_empty_and_never_spawns_netsh() {
        let range = tcp_dynamic_port_range().expect("no netsh is needed");
        assert!(range.is_empty());
        assert!(service_hub_candidates().iter().all(|port| !range.contains(port)));
    }

    #[test]
    fn the_candidates_are_the_contracts_and_sit_below_the_default_dynamic_range() {
        let published: Vec<u16> = contract()["host_service_port_candidates"]["service_hub"]
            .as_array()
            .expect("the contract publishes ServiceHub's candidates")
            .iter()
            .map(|port| u16::try_from(port.as_u64().expect("a port number")).expect("a TCP port"))
            .collect();

        assert_eq!(service_hub_candidates(), published);
        assert_eq!(published.len(), 4);
        assert!(published.iter().all(|port| (1024..49152).contains(port)));
    }

    #[test]
    fn the_first_usable_candidate_is_taken() {
        let mut asked = Vec::new();

        let chosen = select_port(&[18864, 18865, 18866, 18867], |port| {
            asked.push(port);
            None
        });

        assert_eq!(chosen, Ok(18864));
        assert_eq!(asked, vec![18864]);
    }

    #[test]
    fn an_unusable_candidate_is_passed_over_in_contract_order() {
        let mut asked = Vec::new();

        let chosen = select_port(&[18864, 18865, 18866, 18867], |port| {
            asked.push(port);
            match port {
                18864 => Some(Unavailable::InUse),
                18865 => Some(Unavailable::BindAccessDenied),
                _ => None,
            }
        });

        assert_eq!(chosen, Ok(18866));
        assert_eq!(asked, vec![18864, 18865, 18866]);
    }

    #[test]
    fn four_unusable_candidates_are_a_refusal_in_the_contract_shape() {
        let reasons = [
            Unavailable::InUse,
            Unavailable::InsideDynamicPortRange,
            Unavailable::BindAccessDenied,
            Unavailable::InUse,
        ];

        let refusal = select_port(&[18864, 18865, 18866, 18867], |port| {
            Some(reasons[usize::from(port - 18864)])
        })
        .expect_err("no candidate is usable");

        assert_eq!(
            refusal.to_contract_json(),
            serde_json::json!({
                "contract_version": contract()["contract_version"],
                "reason": "fixed_port_candidates_unavailable",
                "placeholder": "service_hub",
                "candidates": [
                    {"port": 18864, "unavailable_because": "in_use"},
                    {"port": 18865, "unavailable_because": "inside_dynamic_port_range"},
                    {"port": 18866, "unavailable_because": "bind_access_denied"},
                    {"port": 18867, "unavailable_because": "in_use"},
                ],
            })
        );
    }

    #[test]
    fn a_candidate_inside_the_host_dynamic_range_is_unusable() {
        assert_eq!(
            candidate_unavailable_because(18864, &(18000..=20000), &HashSet::new()),
            Some(Unavailable::InsideDynamicPortRange)
        );
    }

    #[test]
    fn a_candidate_a_loopback_listener_holds_is_in_use() {
        let holder = TcpListener::bind(("127.0.0.1", 0)).expect("the test can bind loopback");
        let port = holder.local_addr().expect("a bound address").port();

        assert_eq!(
            candidate_unavailable_because(port, &no_dynamic_range(), &HashSet::new()),
            Some(Unavailable::InUse)
        );
    }

    /// A plain wildcard listener does not stop a loopback bind on Windows, so a probe that only bound
    /// loopback would call this port free while an allow by port number exposed that listener. The
    /// probe never binds a wildcard itself (that raises the Windows Firewall prompt), so the holder is
    /// simulated through the listening table, which lists a wildcard listener like any other.
    #[test]
    fn a_candidate_a_wildcard_listener_holds_is_in_use() {
        let listening = HashSet::from([18864]);

        assert_eq!(
            candidate_unavailable_because(18864, &no_dynamic_range(), &listening),
            Some(Unavailable::InUse)
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_listening_table_reads_a_real_listener_and_ignores_a_closed_port() {
        let port = {
            let holder = TcpListener::bind(("127.0.0.1", 0)).expect("the test can bind loopback");
            let port = holder.local_addr().expect("a bound address").port();
            assert!(listening_tcp_ports().expect("the table reads").contains(&port));
            port
        };

        assert!(!listening_tcp_ports().expect("the table reads").contains(&port));
    }

    #[test]
    fn a_free_candidate_is_usable() {
        let port = {
            let earlier = TcpListener::bind(("127.0.0.1", 0)).expect("the test can bind loopback");
            earlier.local_addr().expect("a bound address").port()
        };

        assert_eq!(
            candidate_unavailable_because(port, &no_dynamic_range(), &HashSet::new()),
            None
        );
    }

    /// A candidate taken after one start selected it fails that start inside ServiceHub, at its
    /// `port_selection` stage. The retry is a new start, so it selects again and moves on.
    #[test]
    fn a_retry_selects_again_and_passes_over_a_candidate_taken_since() {
        let (first, second) = {
            let a = TcpListener::bind(("127.0.0.1", 0)).expect("the test can bind loopback");
            let b = TcpListener::bind(("127.0.0.1", 0)).expect("the test can bind loopback");
            (
                a.local_addr().expect("a bound address").port(),
                b.local_addr().expect("a bound address").port(),
            )
        };
        let probe = |port| candidate_unavailable_because(port, &no_dynamic_range(), &HashSet::new());

        assert_eq!(select_port(&[first, second], probe), Ok(first));
        let _taken = TcpListener::bind(("127.0.0.1", first)).expect("another program takes it");

        assert_eq!(select_port(&[first, second], probe), Ok(second));
    }

    #[test]
    fn the_dynamic_port_range_is_read_by_position_not_by_label() {
        let english =
            "\r\nProtocol tcp Dynamic Port Range\r\n---------------------------------\r\n\
                       Start Port      : 49152\r\nNumber of Ports : 16384\r\n\r\n";
        let localized = "\r\nDynamischer Portbereich f\u{fc}r das Protokoll tcp\r\n\
                         ---------------------------------\r\n\
                         Startport        : 1025\r\nAnzahl der Ports : 64511\r\n\r\n";

        assert_eq!(parse_dynamic_port_range(english), Ok(49152..=65535));
        assert_eq!(parse_dynamic_port_range(localized), Ok(1025..=65535));
    }

    #[test]
    fn a_dynamic_port_range_that_cannot_be_read_is_an_error_not_a_default() {
        for text in [
            "",
            "Protocol tcp Dynamic Port Range\r\n------\r\nStart Port : 49152\r\n",
            "Protocol tcp Dynamic Port Range\r\n------\r\nStart Port : 70000\r\nNumber of Ports : 16384\r\n",
        ] {
            assert!(parse_dynamic_port_range(text).is_err(), "accepted {text:?}");
        }
    }
}

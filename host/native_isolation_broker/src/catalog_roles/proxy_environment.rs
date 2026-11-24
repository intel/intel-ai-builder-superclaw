use super::*;
use std::net::{Ipv4Addr, Ipv6Addr};

const LOOPBACK_ENTRIES: [&str; 3] = ["127.0.0.1", "localhost", "::1"];
const MAX_BYPASS_LENGTH: usize = 4096;

/// The proxy variables for a role whose general egress goes through the egress proxy: the shell port
/// for the runtime and openwork-server, the channel port for the router.
///
/// Only `HTTPS_PROXY`/`https_proxy` and the bypass list are exported. The egress proxy tunnels
/// `CONNECT` and answers any other method 405, so `HTTP_PROXY`/`http_proxy` would break every plain
/// `http://` request; those go direct in this stage (log_only) and must be handled before
/// enforcement (EG2-4).
///
/// `NODE_USE_ENV_PROXY=1` is exported too: Node's built-in `fetch` ignores `HTTPS_PROXY` without it,
/// so a Node child of the runtime (a local MCP server started with `npx`) would connect directly and,
/// under an enforcing WFP plan, be refused with `EACCES` and no approval prompt. Only recent Node
/// releases read it (the 24.x line and late 22.x); an older Node ignores it and connects directly.
/// The runtime's `PATH` puts the payload's Node ahead of any machine install, and
/// `scripts/native-backend/native-payload-contract.json` pins that Node to 24.21.0, so a change to
/// that pin must keep a release that reads it.
///
/// There is no unproxied form. A proxy that cannot start fails the start rather than sending a role
/// direct, so a bound value that says `direct` is refused like any other malformed one. The URL names
/// the loopback host this launch was bound to and nothing else: the corporate upstream proxy never
/// reaches this process, only the egress proxy and the Connector, through their own configuration.
pub(super) fn local_proxy_environment(
    validated: &ValidatedStartRequest,
) -> io::Result<Vec<(String, String)>> {
    let proxy = scalar(validated, BrokerScalarPlaceholder::LocalProxyUrl)?;
    let no_proxy = scalar(validated, BrokerScalarPlaceholder::LocalProxyBypass)?;
    let loopback = loopback_host(validated)?;
    let refuse = |message: &str| io::Error::new(io::ErrorKind::InvalidData, message.to_owned());
    // Refusals never quote the value: it is caller text and may carry a credential.
    if !is_local_proxy_url(proxy, loopback) {
        return Err(refuse(
            "a bound local proxy must be http://<loopback host>:<port> with no credentials",
        ));
    }
    let entries: Vec<&str> = no_proxy.split(',').collect();
    if no_proxy.len() > MAX_BYPASS_LENGTH
        || !no_proxy.is_ascii()
        || entries.len() < LOOPBACK_ENTRIES.len()
        || entries[..LOOPBACK_ENTRIES.len()] != LOOPBACK_ENTRIES
    {
        return Err(refuse(
            "a bound local proxy bypass list must start with the loopback entries",
        ));
    }
    if !entries[LOOPBACK_ENTRIES.len()..]
        .iter()
        .all(|entry| is_bypass_entry(entry))
    {
        return Err(refuse(
            "a bound local proxy bypass list entry is not a name, a domain suffix or an address range this policy accepts",
        ));
    }
    Ok(declared(&[
        ("HTTPS_PROXY", proxy.to_owned()),
        ("https_proxy", proxy.to_owned()),
        ("NO_PROXY", no_proxy.to_owned()),
        ("no_proxy", no_proxy.to_owned()),
        ("NODE_USE_ENV_PROXY", "1".to_owned()),
    ]))
}

fn is_local_proxy_url(value: &str, loopback: &str) -> bool {
    value
        .strip_prefix("http://")
        .and_then(|rest| rest.strip_prefix(loopback))
        .and_then(|rest| rest.strip_prefix(':'))
        .is_some_and(|port| {
            !port.is_empty()
                && port.bytes().all(|byte| byte.is_ascii_digit())
                && port.parse::<u16>().is_ok_and(|number| number >= 1024)
        })
}
/// One bypass entry after the loopback three: a name or a domain suffix of at least two labels, or an
/// address, or a CIDR no wider than /8 for IPv4 or /7 for IPv6.
///
/// Two labels because curl, Python and Go all treat a bare `com` as that domain and every subdomain of
/// it, so a one-label entry would send a whole top-level domain around the proxy. A two-label public
/// suffix such as `.co.uk` still does that for its registry, and is accepted as a residual risk.
fn is_bypass_entry(entry: &str) -> bool {
    if let Some(name) = entry.strip_prefix('.') {
        return is_multi_label_name(name);
    }
    if is_multi_label_name(entry) {
        return true;
    }
    let (address, prefix) = match entry.split_once('/') {
        Some((address, prefix)) => (address, Some(prefix)),
        None => (entry, None),
    };
    let within = |widest: u8, bits: u8| {
        prefix.is_none_or(|text| {
            !text.is_empty()
                && text.bytes().all(|byte| byte.is_ascii_digit())
                && text
                    .parse::<u8>()
                    .is_ok_and(|length| (widest..=bits).contains(&length))
        })
    };
    if address.parse::<Ipv4Addr>().is_ok() {
        return within(8, 32);
    }
    if address.parse::<Ipv6Addr>().is_ok() {
        return within(7, 128);
    }
    false
}

/// Dot-separated LDH labels, at least two, each 1-63 characters and not starting or ending with `-`.
fn is_multi_label_name(name: &str) -> bool {
    let labels: Vec<&str> = name.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|label| {
            (1..=63).contains(&label.len())
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

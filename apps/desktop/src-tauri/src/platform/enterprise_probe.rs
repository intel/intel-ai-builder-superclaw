//! Enterprise-network probe via system DNS.
//!
//! The probe host is the release bake `SUPERCLAW_BAKED_ENTERPRISE_PROBE_HOST`, taken from
//! `SUPERCLAW_FEEDBACK_ENTERPRISE_PROBE_HOST`. It is not a source literal. An empty bake
//! returns false and does not resolve. Invoked only when an Intel-signed release
//! binary baked `SUPERCLAW_FEEDBACK_ISSUE_REPO_INTERNAL` and the UI prepares or
//! submits feedback (modal mount, submit, bug-report open). Nothing polls it on a timer.

use std::net::ToSocketAddrs;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);

fn baked_enterprise_probe_host() -> Option<&'static str> {
    option_env!("SUPERCLAW_BAKED_ENTERPRISE_PROBE_HOST")
}

/// True when the baked enterprise probe host resolves. An empty bake is false and does not resolve.
pub fn enterprise_probe_resolves() -> bool {
    resolves_enterprise_probe_host(baked_enterprise_probe_host())
}

pub(crate) fn resolves_enterprise_probe_host(host: Option<&str>) -> bool {
    let Some(host) = host.map(str::trim).filter(|host| !host.is_empty()) else {
        return false;
    };
    let (tx, rx) = mpsc::channel();
    let host = host.to_string();
    thread::spawn(move || {
        let ok = (host.as_str(), 443)
            .to_socket_addrs()
            .ok()
            .and_then(|mut addrs| addrs.next())
            .is_some();
        let _ = tx.send(ok);
    });
    rx.recv_timeout(RESOLVE_TIMEOUT).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_enterprise_probe_host_does_not_resolve() {
        assert!(!resolves_enterprise_probe_host(None));
        assert!(!resolves_enterprise_probe_host(Some("")));
        assert!(!resolves_enterprise_probe_host(Some("   ")));
    }

    #[test]
    fn unbaked_enterprise_probe_host_does_not_resolve() {
        assert!(!enterprise_probe_resolves());
    }
}

//! Corporate HTTP proxy helpers for explicit `ureq` agents.
//!
//! `ureq` does not read `HTTP_PROXY` / `HTTPS_PROXY` when an agent is built
//! manually; apply [`apply_env_proxy`] so egress matches curl on proxy-only networks.

/// First non-empty proxy URL from standard env vars (HTTPS preferred).
pub fn proxy_url_from_env() -> Option<String> {
    for var in [
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        if let Ok(value) = std::env::var(var) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Attach the env proxy when set. Ignores `NO_PROXY` (same as updater manifest fetch).
pub fn apply_env_proxy(mut builder: ureq::AgentBuilder) -> ureq::AgentBuilder {
    if let Some(proxy_url) = proxy_url_from_env() {
        if let Ok(proxy) = ureq::Proxy::new(&proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    builder
}

fn loopback_otlp_target(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    match parsed.host() {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// Like [`apply_env_proxy`], but skips the proxy for loopback OTLP collectors (local tests/dev).
pub fn apply_env_proxy_for_url(builder: ureq::AgentBuilder, target_url: &str) -> ureq::AgentBuilder {
    if loopback_otlp_target(target_url) {
        return builder;
    }
    apply_env_proxy(builder)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_targets_skip_proxy() {
        for url in [
            "http://127.0.0.1:4318/v1/logs",
            "http://localhost:4318",
            "http://[::1]:4318/v1/logs",
            "http://[::1]/v1/logs",
        ] {
            assert!(loopback_otlp_target(url), "expected loopback: {url}");
        }
    }

    #[test]
    fn non_loopback_targets_use_proxy() {
        assert!(!loopback_otlp_target(
            "http://Superc-Alb16-5C6DRyEIpwMz-325311571.us-west-2.elb.amazonaws.com/v1/logs"
        ));
        assert!(!loopback_otlp_target("https://otel.example.com:4318"));
    }
}

use std::time::Duration;

use crate::servicehub::manager::ServiceHubManager;

/// Resolve the ServiceHub connection (base URL + hub token) from manager state.
pub fn hub_connection(manager: &ServiceHubManager) -> Result<(String, String), String> {
    let state = manager
        .inner
        .lock()
        .map_err(|_| "ServiceHub mutex poisoned".to_string())?;
    let port = state
        .hub_port
        .ok_or_else(|| "ServiceHub port unset (hub not ready)".to_string())?;
    let token = state
        .hub_token
        .clone()
        .ok_or_else(|| "ServiceHub token unset (hub not ready)".to_string())?;
    Ok((format!("http://127.0.0.1:{port}"), token))
}

fn to_json(resp: ureq::Response, ctx: &str) -> Result<serde_json::Value, String> {
    let status = resp.status();
    if !(200..300).contains(&status) {
        return Err(format!("{ctx} returned HTTP {status}"));
    }
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("{ctx} returned invalid JSON: {e}"))
}

/// GET `{hub_url}{path}` through the ServiceHub proxy with Bearer auth.
pub fn proxy_get(
    manager: &ServiceHubManager,
    path: &str,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let (hub_url, token) = hub_connection(manager)?;
    let url = format!("{hub_url}{path}");
    let resp = ureq::get(&url)
        .timeout(Duration::from_secs(timeout_secs))
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("GET {path} failed: {e}"))?;
    to_json(resp, &format!("GET {path}"))
}

/// POST a JSON body to `{hub_url}{path}` through the ServiceHub proxy.
pub fn proxy_post(
    manager: &ServiceHubManager,
    path: &str,
    body: &str,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    let (hub_url, token) = hub_connection(manager)?;
    let url = format!("{hub_url}{path}");
    let resp = ureq::post(&url)
        .timeout(Duration::from_secs(timeout_secs))
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(body)
        .map_err(|e| format!("POST {path} failed: {e}"))?;
    to_json(resp, &format!("POST {path}"))
}

/// Extract `workspace_container_path` from a sandbox-config JSON body.
fn parse_container_path(body: &serde_json::Value) -> Result<String, String> {
    body.get("workspace_container_path")
        .and_then(serde_json::Value::as_str)
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .ok_or_else(|| "sandbox-config response missing workspace_container_path".to_string())
}

/// Fetch the container-side workspace path via the ServiceHub → sandbox_manager
/// proxy. Callers fall back to `DEFAULT_CONTAINER_PATH` on error.
pub fn fetch_workspace_container_path(manager: &ServiceHubManager) -> Result<String, String> {
    let body = proxy_get(manager, "/sandbox-manager/v1/agent/sandbox/config", 2)?;
    parse_container_path(&body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servicehub::manager::ServiceHubManager;

    #[test]
    fn hub_connection_errors_when_port_unset() {
        let manager = ServiceHubManager::default();
        let result = hub_connection(&manager);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("ServiceHub"));
    }

    #[test]
    fn hub_connection_returns_url_and_token_when_set() {
        let manager = ServiceHubManager::default();
        {
            let mut st = manager.inner.lock().unwrap();
            st.hub_port = Some(19000);
            st.hub_token = Some("devtoken".to_string());
        }
        let (url, token) = hub_connection(&manager).expect("connection");
        assert_eq!(url, "http://127.0.0.1:19000");
        assert_eq!(token, "devtoken");
    }

    #[test]
    fn parse_container_path_reads_field() {
        let body = serde_json::json!({ "workspace_container_path": "/root/workspace" });
        assert_eq!(parse_container_path(&body).unwrap(), "/root/workspace");
    }

    #[test]
    fn parse_container_path_errors_on_missing_or_empty() {
        assert!(parse_container_path(&serde_json::json!({})).is_err());
        assert!(
            parse_container_path(&serde_json::json!({ "workspace_container_path": "" })).is_err()
        );
    }
}

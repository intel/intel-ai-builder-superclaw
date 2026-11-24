use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

/// Same ceiling as `POST /workspace/:id/gmail/credentials`.
const MAX_CLIENT_FILE_BYTES: u64 = 100 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GmailClientDownload {
    pub name: String,
    pub content: String,
    pub modified_ms: u64,
}

/// Google saves a new OAuth client as `client_secret_<id>.json`; users who
/// follow older guides rename it `credentials.json`. Browsers add ` (1)` to
/// repeats, which the prefix match keeps.
fn is_client_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".json")
        && (lower.starts_with("client_secret") || lower.starts_with("credentials"))
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The placeholder `client_id` in the card's Template download (`credentials_template.json`).
const TEMPLATE_CLIENT_ID: &str = "YOUR_CLIENT_ID";

/// The file's text if it is an OAuth client JSON. Anything else named like one
/// (a service-account key, another tool's `credentials.json`, the unfilled template)
/// never reaches the webview.
fn read_oauth_client(path: &Path) -> Option<String> {
    let mut content = String::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_CLIENT_FILE_BYTES + 1)
        .read_to_string(&mut content)
        .ok()?;
    if content.len() as u64 > MAX_CLIENT_FILE_BYTES {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    ["installed", "web"]
        .iter()
        .any(|kind| {
            json[kind]["client_id"]
                .as_str()
                .is_some_and(|id| !id.starts_with(TEMPLATE_CLIENT_ID))
        })
        .then_some(content)
}

/// Newest OAuth client file in `dir` written after `since_ms`.
fn newest_client_file(dir: &Path, since_ms: u64) -> Option<GmailClientDownload> {
    let mut newest: Option<(u64, String, String)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_client_file_name(&name) {
            continue;
        }
        // symlink_metadata: a link in Downloads must not read a file elsewhere.
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_CLIENT_FILE_BYTES {
            continue;
        }
        // A browser renames its partial download into place, keeping the partial's
        // creation time, so either timestamp can be the one that marks it new.
        let written = meta
            .modified()
            .map(millis)
            .unwrap_or(0)
            .max(meta.created().map(millis).unwrap_or(0));
        if written <= since_ms || newest.as_ref().is_some_and(|(ms, _, _)| *ms >= written) {
            continue;
        }
        let Some(content) = read_oauth_client(&entry.path()) else {
            continue;
        };
        newest = Some((written, name, content));
    }
    let (modified_ms, name, content) = newest?;
    Some(GmailClientDownload {
        name,
        content,
        modified_ms,
    })
}

/// Deletes `name` from `dir` only if it is a plain file there (a bare file name, not a
/// link) that still holds `expected`, the client SuperClaw uploaded. A file replaced
/// since is someone else's only copy.
fn remove_client_file(dir: &Path, name: &str, expected: &str) -> Result<(), String> {
    if !is_client_file_name(name) || name.contains(['/', '\\', ':']) || name.starts_with('.') {
        return Err("Not a Gmail client file name.".into());
    }
    let path = dir.join(name);
    let meta = fs::symlink_metadata(&path).map_err(|e| format!("{name}: {e}"))?;
    if !meta.is_file() || read_oauth_client(&path).as_deref() != Some(expected) {
        return Err(format!(
            "{name} is not the Gmail client SuperClaw uploaded."
        ));
    }
    fs::remove_file(&path).map_err(|e| format!("{name}: {e}"))
}

fn downloads_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .download_dir()
        .map_err(|e| format!("Failed to resolve downloads dir: {e}"))
}

/// The OAuth client JSON the user downloaded since `since_ms`, if any. Polled every
/// 2 s, so the scan runs off the main thread: a slow or redirected Downloads folder
/// must not freeze the window.
#[tauri::command]
pub async fn find_gmail_client_download(
    app: AppHandle,
    since_ms: u64,
) -> Result<Option<GmailClientDownload>, String> {
    let dir = downloads_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || newest_client_file(&dir, since_ms))
        .await
        .map_err(|e| format!("Downloads scan failed to run: {e}"))
}

/// Removes an uploaded OAuth client JSON from Downloads, when the user asks to.
#[tauri::command]
pub fn remove_gmail_client_download(
    app: AppHandle,
    name: String,
    content: String,
) -> Result<(), String> {
    remove_client_file(&downloads_dir(&app)?, &name, &content)
}

#[cfg(test)]
mod tests {
    use super::{is_client_file_name, millis, newest_client_file, remove_client_file};
    use std::fs;
    use std::time::SystemTime;

    #[test]
    fn matches_google_and_renamed_client_files_only() {
        assert!(is_client_file_name(
            "client_secret_123-abc.apps.googleusercontent.com.json"
        ));
        assert!(is_client_file_name(
            "client_secret_123-abc.apps.googleusercontent.com (1).json"
        ));
        assert!(is_client_file_name("credentials.json"));
        assert!(is_client_file_name("Credentials (2).JSON"));
        assert!(!is_client_file_name("credentials_template.json.crdownload"));
        assert!(!is_client_file_name("my-project-1a2b3c.json"));
        assert!(!is_client_file_name("client_secret.txt"));
    }

    #[test]
    fn returns_only_a_client_file_written_after_the_cutoff() {
        let dir = std::env::temp_dir().join(format!("superclaw-gmail-dl-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create downloads");

        fs::write(dir.join("credentials.json"), br#"{"installed":{}}"#).expect("write old file");
        let cutoff = millis(SystemTime::now());
        assert!(
            newest_client_file(&dir, cutoff).is_none(),
            "a file already there is not the new client"
        );

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("notes.json"), b"{}").expect("write unrelated");
        fs::create_dir_all(dir.join("client_secret_dir.json"))
            .expect("dir with a client-like name");
        fs::write(
            dir.join("client_secret_big.json"),
            vec![b' '; 100 * 1024 + 1],
        )
        .expect("write oversized");
        fs::write(
            dir.join("credentials (1).json"),
            br#"{"type":"service_account","private_key":"k"}"#,
        )
        .expect("write service-account key");
        fs::write(
            dir.join("credentials_template.json"),
            br#"{"installed":{"client_id":"YOUR_CLIENT_ID.apps.googleusercontent.com"}}"#,
        )
        .expect("write the card's template");
        assert!(newest_client_file(&dir, cutoff).is_none());

        fs::write(
            dir.join("client_secret_1.apps.googleusercontent.com.json"),
            br#"{"installed":{"client_id":"a"}}"#,
        )
        .expect("write new client");
        let found = newest_client_file(&dir, cutoff).expect("new client file is found");
        assert_eq!(
            found.name,
            "client_secret_1.apps.googleusercontent.com.json"
        );
        assert_eq!(found.content, r#"{"installed":{"client_id":"a"}}"#);
        assert!(found.modified_ms > cutoff);
        assert!(
            newest_client_file(&dir, found.modified_ms).is_none(),
            "the same file is not returned twice"
        );

        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("credentials (2).json"), b"not json").expect("write newer junk");
        assert_eq!(
            newest_client_file(&dir, cutoff).map(|f| f.name).as_deref(),
            Some("client_secret_1.apps.googleusercontent.com.json"),
            "a newer file that is not a client does not hide the client"
        );

        let uploaded = found.content.as_str();
        assert!(remove_client_file(&dir, "credentials (2).json", uploaded).is_err());
        assert!(remove_client_file(&dir, "..\\credentials.json", uploaded).is_err());
        assert!(remove_client_file(&dir, "notes.json", uploaded).is_err());
        assert!(dir.join("credentials (2).json").exists());

        fs::write(
            dir.join("credentials.json"),
            br#"{"installed":{"client_id":"another-project"}}"#,
        )
        .expect("replace with another client");
        assert!(
            remove_client_file(&dir, "credentials.json", uploaded).is_err(),
            "a client that is not the one uploaded is not deleted"
        );
        assert!(dir.join("credentials.json").exists());

        remove_client_file(
            &dir,
            "client_secret_1.apps.googleusercontent.com.json",
            uploaded,
        )
        .expect("remove the client file");
        assert!(!dir
            .join("client_secret_1.apps.googleusercontent.com.json")
            .exists());

        let _ = fs::remove_dir_all(&dir);
    }
}

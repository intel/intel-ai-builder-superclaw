use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn main() {
    if let Ok(manifest_dir) = env::var("CARGO_MANIFEST_DIR") {
        let index_html = PathBuf::from(&manifest_dir)
            .join("../../ui/dist")
            .join("index.html");
        if index_html.exists() {
            println!("cargo:rerun-if-changed={}", index_html.display());
        }
    }
    // Read with option_env! in commands/updater.rs; a QA build must not reuse a
    // cached artifact compiled without it.
    println!("cargo:rerun-if-env-changed=SUPERCLAW_OTA_TEST_CHANNEL");
    println!("cargo:rerun-if-env-changed=SUPERCLAW_BUILD_VERSION");
    emit_build_info();
    emit_packaged_observability_env();
    emit_packaged_feedback_issue_repo();
    ensure_opencode_sidecar();
    ensure_openwork_server_sidecar();
    ensure_opencode_router_sidecar();
    ensure_orchestrator_sidecar();
    ensure_versions_manifest();
    tauri_build::build();
}

fn ensure_versions_manifest() {
    let profile = env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        return;
    }

    let target = env::var("CARGO_CFG_TARGET_TRIPLE")
        .or_else(|_| env::var("TARGET"))
        .or_else(|_| env::var("TAURI_ENV_TARGET_TRIPLE"))
        .unwrap_or_default();
    if target.is_empty() {
        return;
    }

    let manifest_dir = env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let sidecar_dir = manifest_dir.join("sidecars");
    let canonical_path = sidecar_dir.join("versions.json");
    let target_path = sidecar_dir.join(format!("versions.json-{target}"));

    if canonical_path.exists() && target_path.exists() {
        return;
    }

    if fs::create_dir_all(&sidecar_dir).is_err() {
        return;
    }

    if !canonical_path.exists() {
        let _ = fs::write(&canonical_path, "{}\n");
    }
    if !target_path.exists() {
        let _ = fs::write(&target_path, "{}\n");
    }
}

fn emit_build_info() {
    let sha = env::var("OPENWORK_GIT_SHA")
        .ok()
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| {
            let output = Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()?;
            if !output.status.success() {
                return None;
            }
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        });
    if let Some(value) = sha {
        println!("cargo:rustc-env=OPENWORK_GIT_SHA={}", value);
    }

    let build_epoch = env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .or_else(|| {
            // Best-effort fallback; not reproducible, but useful in dev builds.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs();
            Some(now.to_string())
        });

    if let Some(value) = build_epoch {
        println!("cargo:rustc-env=OPENWORK_BUILD_EPOCH={}", value);
    }
}

/// Bake observability env from the installer CI job into release binaries when set.
///
/// Gated on `PROFILE=release`: `cargo test`/`cargo build` (debug) never bake, even if a
/// developer's shell happens to export `OTEL_EXPORTER_OTLP_ENDPOINT` for an unrelated reason —
/// otherwise ambient shell state could silently leak into test binaries (debug builds still get
/// the endpoint at runtime via `.env`, see `otlp_env::load_debug_env_file`).
fn emit_packaged_observability_env() {
    const PAIRS: &[(&str, &str)] = &[
        ("OTEL_EXPORTER_OTLP_ENDPOINT", "SUPERCLAW_BAKED_OTLP_ENDPOINT"),
        ("SUPERCLAW_EDGE_CREDENTIAL_ID", "SUPERCLAW_BAKED_EDGE_CREDENTIAL_ID"),
        ("SUPERCLAW_OTLP_EDGE_TOKEN", "SUPERCLAW_BAKED_OTLP_EDGE_TOKEN"),
        ("SUPERCLAW_FEEDBACK_EDGE_TOKEN", "SUPERCLAW_BAKED_FEEDBACK_EDGE_TOKEN"),
        ("SUPERCLAW_TELEMETRY_CHANNEL", "SUPERCLAW_BAKED_BUILD_CHANNEL"),
        (
            "SUPERCLAW_EDGE_CREDENTIAL_REGISTRY",
            "SUPERCLAW_BAKED_EDGE_CREDENTIAL_REGISTRY",
        ),
    ];
    println!("cargo:rerun-if-env-changed=PROFILE");
    let release_profile = env::var("PROFILE").as_deref() == Ok("release");
    for (env_key, rustc_key) in PAIRS {
        println!("cargo:rerun-if-env-changed={env_key}");
        if !release_profile {
            continue;
        }
        let Ok(value) = env::var(env_key) else {
            continue;
        };
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        println!("cargo:rustc-env={rustc_key}={trimmed}");
    }
}

/// Bake feedback repositories for official release builds.
///
/// `SUPERCLAW_FEEDBACK_ISSUE_REPO_INTERNAL` is the corp-network target.
/// `SUPERCLAW_FEEDBACK_ISSUE_REPO_PUBLIC` is the public target.
/// `SUPERCLAW_FEEDBACK_ENTERPRISE_PROBE_HOST` is the DNS host for that check.
/// `SUPERCLAW_FEEDBACK_EMAIL` is the mailto fallback.
/// Debug builds skip all four bakes. An empty variable leaves that target
/// unset. An empty public variable leaves the compiled default
/// `intel/intel-ai-builder`. A non-empty value that is not a slug, hostname,
/// or email is not baked, and the release build prints a cargo warning.
fn emit_packaged_feedback_issue_repo() {
    println!("cargo:rerun-if-env-changed=PROFILE");
    println!("cargo:rerun-if-env-changed=SUPERCLAW_FEEDBACK_ISSUE_REPO_INTERNAL");
    println!("cargo:rerun-if-env-changed=SUPERCLAW_FEEDBACK_ISSUE_REPO_PUBLIC");
    println!("cargo:rerun-if-env-changed=SUPERCLAW_FEEDBACK_ENTERPRISE_PROBE_HOST");
    println!("cargo:rerun-if-env-changed=SUPERCLAW_FEEDBACK_EMAIL");
    if env::var("PROFILE").as_deref() != Ok("release") {
        return;
    }
    emit_release_feedback_slug(
        "SUPERCLAW_FEEDBACK_ISSUE_REPO_INTERNAL",
        "SUPERCLAW_BAKED_FEEDBACK_ISSUE_REPO_INTERNAL",
    );
    emit_release_feedback_slug(
        "SUPERCLAW_FEEDBACK_ISSUE_REPO_PUBLIC",
        "SUPERCLAW_BAKED_FEEDBACK_ISSUE_REPO_PUBLIC",
    );
    emit_release_enterprise_probe_host();
    emit_release_feedback_email();
    warn_when_internal_feedback_repo_is_public();
}

fn warn_when_internal_feedback_repo_is_public() {
    let Ok(internal) = env::var("SUPERCLAW_FEEDBACK_ISSUE_REPO_INTERNAL") else {
        return;
    };
    let internal = internal.trim();
    if !is_github_issue_repo_slug(internal) {
        return;
    }
    let public_repo = env::var("SUPERCLAW_FEEDBACK_ISSUE_REPO_PUBLIC")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|slug| is_github_issue_repo_slug(slug))
        .unwrap_or_else(|| "intel/intel-ai-builder".to_string());
    if internal.eq_ignore_ascii_case(&public_repo) {
        println!(
            "cargo:warning=SUPERCLAW_FEEDBACK_ISSUE_REPO_INTERNAL matches the public repository; the corp-network target stays unset"
        );
    }
}

fn emit_release_feedback_slug(env_key: &str, rustc_key: &str) {
    let Ok(value) = env::var(env_key) else {
        return;
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    if !is_github_issue_repo_slug(trimmed) {
        println!(
            "cargo:warning={env_key} is not owner/name; the release build will not bake it"
        );
        return;
    }
    println!("cargo:rustc-env={rustc_key}={trimmed}");
}

fn is_github_issue_repo_slug(slug: &str) -> bool {
    let Some((owner, name)) = slug.split_once('/') else {
        return false;
    };
    !name.contains('/') && is_github_slug_part(owner) && is_github_slug_part(name)
}

fn is_github_slug_part(part: &str) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn emit_release_enterprise_probe_host() {
    let Ok(value) = env::var("SUPERCLAW_FEEDBACK_ENTERPRISE_PROBE_HOST") else {
        return;
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    if !is_enterprise_probe_host(trimmed) {
        println!(
            "cargo:warning=SUPERCLAW_FEEDBACK_ENTERPRISE_PROBE_HOST is not a hostname; the enterprise probe stays unset"
        );
        return;
    }
    println!("cargo:rustc-env=SUPERCLAW_BAKED_ENTERPRISE_PROBE_HOST={trimmed}");
}

fn is_enterprise_probe_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            let bytes = label.as_bytes();
            let Some((first, rest)) = bytes.split_first() else {
                return false;
            };
            let Some(last) = bytes.last() else {
                return false;
            };
            bytes.len() <= 63
                && first.is_ascii_alphanumeric()
                && last.is_ascii_alphanumeric()
                && rest
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        })
}

fn emit_release_feedback_email() {
    let Ok(value) = env::var("SUPERCLAW_FEEDBACK_EMAIL") else {
        return;
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    if !is_feedback_email(trimmed) {
        println!(
            "cargo:warning=SUPERCLAW_FEEDBACK_EMAIL is not an email address; mailto stays unset"
        );
        return;
    }
    println!("cargo:rustc-env=SUPERCLAW_BAKED_FEEDBACK_EMAIL={trimmed}");
}

fn is_feedback_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !value.contains(char::is_whitespace)
        && !local.contains('@')
        && is_enterprise_probe_host(domain)
}

fn ensure_orchestrator_sidecar() {
    let target = env::var("CARGO_CFG_TARGET_TRIPLE")
        .or_else(|_| env::var("TARGET"))
        .or_else(|_| env::var("TAURI_ENV_TARGET_TRIPLE"))
        .unwrap_or_default();
    if target.is_empty() {
        return;
    }

    let manifest_dir = env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let sidecar_dir = manifest_dir.join("sidecars");

    let canonical_name = if target.contains("windows") {
        "openwork-orchestrator.exe"
    } else {
        "openwork-orchestrator"
    };
    let mut target_name = format!("openwork-orchestrator-{target}");
    if target.contains("windows") {
        target_name.push_str(".exe");
    }

    let dest_path = sidecar_dir.join(canonical_name);
    let target_dest_path = sidecar_dir.join(target_name);

    let profile = env::var("PROFILE").unwrap_or_default();
    if !dest_path.exists() {
        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
    }
    if !target_dest_path.exists() {
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
    }

    if dest_path.exists() && target_dest_path.exists() {
        return;
    }

    if target_dest_path.exists() && !dest_path.exists() {
        if copy_sidecar(&target_dest_path, &dest_path, &target) {
            return;
        }
    }

    let source_path = env::var("OPENWORK_ORCHESTRATOR_BIN_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| {
            find_in_path(if target.contains("windows") {
                "openwork.exe"
            } else {
                "openwork"
            })
        });

    let Some(source_path) = source_path else {
        println!(
            "cargo:warning=orchestrator sidecar missing at {} (set OPENWORK_ORCHESTRATOR_BIN_PATH or install openwork-orchestrator)",
            dest_path.display()
        );
        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
        return;
    };

    if fs::create_dir_all(&sidecar_dir).is_err() {
        return;
    }

    let copied = copy_sidecar(&source_path, &dest_path, &target);
    if copied {
        #[cfg(unix)]
        {
            let _ = fs::set_permissions(&dest_path, fs::Permissions::from_mode(0o755));
        }
        let _ = copy_sidecar(&dest_path, &target_dest_path, &target);
    } else {
        println!(
            "cargo:warning=Failed to copy orchestrator sidecar from {} to {}",
            source_path.display(),
            dest_path.display()
        );
        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
    }

    if !dest_path.exists() {
        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
    }
    if !target_dest_path.exists() {
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
    }
}

fn ensure_opencode_sidecar() {
    let target = env::var("CARGO_CFG_TARGET_TRIPLE")
        .or_else(|_| env::var("TARGET"))
        .or_else(|_| env::var("TAURI_ENV_TARGET_TRIPLE"))
        .unwrap_or_default();
    if target.is_empty() {
        return;
    }

    let manifest_dir = env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let sidecar_dir = manifest_dir.join("sidecars");

    let canonical_name = if target.contains("windows") {
        "opencode.exe"
    } else {
        "opencode"
    };

    let mut target_name = format!("opencode-{target}");
    if target.contains("windows") {
        target_name.push_str(".exe");
    }

    let dest_path = sidecar_dir.join(canonical_name);
    let target_dest_path = sidecar_dir.join(target_name);

    let profile = env::var("PROFILE").unwrap_or_default();
    if !dest_path.exists() {
        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
    }
    if !target_dest_path.exists() {
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
    }

    if dest_path.exists() && target_dest_path.exists() {
        return;
    }

    if target_dest_path.exists() && !dest_path.exists() {
        if copy_sidecar(&target_dest_path, &dest_path, &target) {
            return;
        }
    }

    let source_path = env::var("OPENCODE_BIN_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| {
            find_in_path(if target.contains("windows") {
                "opencode.exe"
            } else {
                "opencode"
            })
        });

    let Some(source_path) = source_path else {
        println!(
      "cargo:warning=OpenCode sidecar missing at {} (set OPENCODE_BIN_PATH or install OpenCode)",
      dest_path.display()
    );

        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
        return;
    };

    if fs::create_dir_all(&sidecar_dir).is_err() {
        return;
    }

    let copied = copy_sidecar(&source_path, &dest_path, &target);

    if copied {
        #[cfg(unix)]
        {
            let _ = fs::set_permissions(&dest_path, fs::Permissions::from_mode(0o755));
        }
        let _ = copy_sidecar(&dest_path, &target_dest_path, &target);
    } else {
        println!(
            "cargo:warning=Failed to copy OpenCode sidecar from {} to {}",
            source_path.display(),
            dest_path.display()
        );
        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
    }
}

fn ensure_openwork_server_sidecar() {
    let target = env::var("CARGO_CFG_TARGET_TRIPLE")
        .or_else(|_| env::var("TARGET"))
        .or_else(|_| env::var("TAURI_ENV_TARGET_TRIPLE"))
        .unwrap_or_default();
    if target.is_empty() {
        return;
    }

    let manifest_dir = env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let sidecar_dir = manifest_dir.join("sidecars");

    let canonical_name = if target.contains("windows") {
        "openwork-server.exe"
    } else {
        "openwork-server"
    };

    let mut target_name = format!("openwork-server-{target}");
    if target.contains("windows") {
        target_name.push_str(".exe");
    }

    let dest_path = sidecar_dir.join(canonical_name);
    let target_dest_path = sidecar_dir.join(target_name);

    if dest_path.exists() {
        return;
    }

    if target_dest_path.exists() {
        if copy_sidecar(&target_dest_path, &dest_path, &target) {
            return;
        }
    }

    let source_path = env::var("OPENWORK_SERVER_BIN_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| {
            find_in_path(if target.contains("windows") {
                "openwork-server.exe"
            } else {
                "openwork-server"
            })
        });

    let profile = env::var("PROFILE").unwrap_or_default();

    let Some(source_path) = source_path else {
        println!(
      "cargo:warning=OpenWork server sidecar missing at {} (set OPENWORK_SERVER_BIN_PATH or install openwork-server)",
      dest_path.display()
    );

        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
        return;
    };

    if fs::create_dir_all(&sidecar_dir).is_err() {
        return;
    }

    let copied = copy_sidecar(&source_path, &dest_path, &target);

    if copied {
        #[cfg(unix)]
        {
            let _ = fs::set_permissions(&dest_path, fs::Permissions::from_mode(0o755));
        }
        let _ = copy_sidecar(&dest_path, &target_dest_path, &target);
    } else {
        println!(
            "cargo:warning=Failed to copy OpenWork server sidecar from {} to {}",
            source_path.display(),
            dest_path.display()
        );
        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
    }

    if !dest_path.exists() {
        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
    }
    if !target_dest_path.exists() {
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
    }
}

fn ensure_opencode_router_sidecar() {
    let target = env::var("CARGO_CFG_TARGET_TRIPLE")
        .or_else(|_| env::var("TARGET"))
        .or_else(|_| env::var("TAURI_ENV_TARGET_TRIPLE"))
        .unwrap_or_default();
    if target.is_empty() {
        return;
    }

    let manifest_dir = env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let sidecar_dir = manifest_dir.join("sidecars");

    let canonical_name = if target.contains("windows") {
        "opencode-router.exe"
    } else {
        "opencode-router"
    };

    let mut target_name = format!("opencode-router-{target}");
    if target.contains("windows") {
        target_name.push_str(".exe");
    }

    let dest_path = sidecar_dir.join(canonical_name);
    let target_dest_path = sidecar_dir.join(target_name);

    if dest_path.exists() {
        return;
    }

    if target_dest_path.exists() {
        if copy_sidecar(&target_dest_path, &dest_path, &target) {
            return;
        }
    }

    let source_path = env::var("OPENCODE_ROUTER_BIN_PATH")
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| {
            find_in_path(if target.contains("windows") {
                "opencode-router.exe"
            } else {
                "opencode-router"
            })
        });

    let profile = env::var("PROFILE").unwrap_or_default();

    let Some(source_path) = source_path else {
        println!(
      "cargo:warning=OpenCodeRouter sidecar missing at {} (set OPENCODE_ROUTER_BIN_PATH or install opencode-router)",
      dest_path.display()
    );

        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
        return;
    };

    if fs::create_dir_all(&sidecar_dir).is_err() {
        return;
    }

    let copied = copy_sidecar(&source_path, &dest_path, &target);

    if copied {
        #[cfg(unix)]
        {
            let _ = fs::set_permissions(&dest_path, fs::Permissions::from_mode(0o755));
        }
        let _ = copy_sidecar(&dest_path, &target_dest_path, &target);
    } else {
        println!(
            "cargo:warning=Failed to copy OpenCodeRouter sidecar from {} to {}",
            source_path.display(),
            dest_path.display()
        );
        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
    }

    if !dest_path.exists() {
        create_debug_stub(&dest_path, &sidecar_dir, &profile, &target);
    }
    if !target_dest_path.exists() {
        create_debug_stub(&target_dest_path, &sidecar_dir, &profile, &target);
    }
}

fn copy_sidecar(source_path: &PathBuf, dest_path: &PathBuf, target: &str) -> bool {
    let mut copied = fs::copy(source_path, dest_path).is_ok();

    #[cfg(unix)]
    if !copied {
        if std::os::unix::fs::symlink(source_path, dest_path).is_ok() {
            copied = true;
        }
    }

    #[cfg(windows)]
    if !copied {
        if fs::hard_link(source_path, dest_path).is_ok() {
            copied = true;
        }
    }

    if copied {
        #[cfg(unix)]
        {
            let _ = fs::set_permissions(dest_path, fs::Permissions::from_mode(0o755));
        }
    } else if target.contains("windows") {
        let _ = fs::remove_file(dest_path);
    }

    copied
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    env::split_paths(&paths).find_map(|dir| {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            Some(candidate)
        } else {
            None
        }
    })
}

fn create_debug_stub(dest_path: &PathBuf, sidecar_dir: &PathBuf, profile: &str, target: &str) {
    if profile == "release" || target.contains("windows") {
        return;
    }

    if fs::create_dir_all(sidecar_dir).is_err() {
        return;
    }

    let stub = "#!/usr/bin/env bash\n\
echo 'Sidecar missing. Install the binary or set the *_BIN_PATH env var.'\n\
exit 1\n";
    if fs::write(dest_path, stub).is_ok() {
        #[cfg(unix)]
        let _ = fs::set_permissions(dest_path, fs::Permissions::from_mode(0o755));
    }
}

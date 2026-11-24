//! Embeds the broker elevation manifest at link time so every product invocation enters through
//! Windows UAC instead of depending only on a caller-provided `runas` verb.
//!
//! Also embeds a version resource (file description, product and company name) in the broker and the
//! launcher. Without it the UAC consent dialog has nothing to show but the bare file name. The resource
//! is independent of the manifest: the linker flags below are unchanged.

use std::env;

mod build_version;

/// Only the broker asks for elevation. `native_isolation_launcher`, `native_isolation_tier_bootstrap`
/// and `native_isolation_test_child` must stay out of this list: the launcher's whole purpose is to run
/// unelevated, the bootstrap runs as a tier account, and a `requireAdministrator` manifest on either
/// would reintroduce the elevated launch this design exists to remove. `tests/launcher_closure.rs` and
/// `tests/bootstrap_closure.rs` assert neither binary carries such a manifest.
const ELEVATED_BINS: &[&str] = &["native_isolation_broker"];
const MANIFEST_FILE: &str = "broker.manifest";

/// Binaries that get file properties, with the resource script that describes each. The test child is
/// a test helper and is left out.
const VERSIONED_BINS: &[(&str, &str)] = &[
    ("native_isolation_broker", "resources/broker.rc"),
    ("native_isolation_launcher", "resources/launcher.rc"),
    (
        "native_isolation_tier_bootstrap",
        "resources/tier_bootstrap.rc",
    ),
];

fn main() {
    println!("cargo:rerun-if-changed={MANIFEST_FILE}");
    println!("cargo:rerun-if-changed=resources");
    println!("cargo:rerun-if-env-changed=SUPERCLAW_BUILD_VERSION");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    if env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("set by Cargo for build scripts");
    let manifest_path = format!("{manifest_dir}/{MANIFEST_FILE}");

    link_vcruntime_statically();

    for bin in ELEVATED_BINS {
        println!("cargo:rustc-link-arg-bin={bin}=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-bin={bin}=/MANIFESTUAC:NO");
        println!("cargo:rustc-link-arg-bin={bin}=/MANIFESTINPUT:{manifest_path}");
    }

    let crate_part = |part| {
        env::var(format!("CARGO_PKG_VERSION_{part}"))
            .expect("set by Cargo")
            .parse::<u16>()
            .expect("the crate version fits a FILEVERSION part")
    };
    let version = build_version::resolve(
        env::var("SUPERCLAW_BUILD_VERSION").ok().as_deref(),
        [
            crate_part("MAJOR"),
            crate_part("MINOR"),
            crate_part("PATCH"),
        ],
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let [major, minor, patch, build] = version;
    let macros = [
        format!("SC_VERSION_MAJOR={major}"),
        format!("SC_VERSION_MINOR={minor}"),
        format!("SC_VERSION_PATCH={patch}"),
        format!("SC_VERSION_BUILD={build}"),
        format!("SC_VERSION_STRING=\"{}\"", build_version::display(version)),
    ];
    for (bin, script) in VERSIONED_BINS {
        embed_resource::compile_for(script, [bin], &macros)
            .manifest_required()
            .expect("compiling the version resource with rc.exe");
    }
}

/// Links the VC++ runtime statically and keeps the Universal CRT dynamic (Microsoft's "hybrid CRT").
/// By default every binary imports `VCRUNTIME140.dll`, which ships only with the Visual C++
/// Redistributable, so a clean Windows install cannot start the broker or the launcher. The UCRT
/// (`ucrtbase.dll`, `api-ms-win-crt-*`) is part of Windows 10 and later and stays dynamic.
/// `tests/launcher_closure.rs` asserts the shipped binaries no longer import `VCRUNTIME140.dll`.
fn link_vcruntime_statically() {
    let features = env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default();
    if features.split(',').any(|feature| feature == "crt-static") {
        return;
    }
    for arg in [
        "/NODEFAULTLIB:msvcrt.lib",
        "/NODEFAULTLIB:msvcrtd.lib",
        "/NODEFAULTLIB:vcruntime.lib",
        "/NODEFAULTLIB:vcruntimed.lib",
        "/NODEFAULTLIB:libcmtd.lib",
        "/NODEFAULTLIB:libvcruntimed.lib",
        "/NODEFAULTLIB:libucrt.lib",
        "/NODEFAULTLIB:libucrtd.lib",
        "/DEFAULTLIB:libcmt.lib",
        "/DEFAULTLIB:libvcruntime.lib",
        "/DEFAULTLIB:ucrt.lib",
    ] {
        println!("cargo:rustc-link-arg={arg}");
    }
}

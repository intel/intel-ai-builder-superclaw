//! Entry point for `native_isolation_tier_bootstrap`, the first-hop image of a tier launch (#3499,
//! #3400). `tier_bootstrap/mod.rs` describes what it does; this file describes what it is built from.
//!
//! # A GUI-subsystem image with a declared closure
//!
//! The subsystem is `windows` so the process gets no console host: a `conhost.exe` would be one more
//! process of the tier on `WinSta0`, created before this one could protect anything. Its module closure is
//! declared here with `#[path]`, as `launcher_main.rs` declares the launcher's, rather than by linking the
//! broker library, so what the image can reach is a property of this list. It holds no privileged module,
//! none of the launcher's own modules, and no module that imports `user32`, `gdi32` or `shell32`
//! statically: `tests/bootstrap_closure.rs` checks the list, the source behind it and the built image's
//! import table.
//!
//! Every module is also compiled into the library, which is where its unit tests run; `test = false` keeps
//! them from running twice.

#![windows_subsystem = "windows"]

#[cfg(not(windows))]
compile_error!("native_isolation_tier_bootstrap supports Windows only");

#[path = "frame.rs"]
#[allow(dead_code)]
mod frame;
#[path = "launch_environment.rs"]
#[allow(dead_code)]
mod launch_environment;
#[path = "object_descriptor.rs"]
#[allow(dead_code)]
mod object_descriptor;
#[path = "pipe_io.rs"]
#[allow(dead_code)]
mod pipe_io;
#[path = "process_win32.rs"]
#[allow(dead_code)]
mod process_win32;
#[path = "random_bytes.rs"]
#[allow(dead_code)]
mod random_bytes;
#[path = "sid_text.rs"]
#[allow(dead_code)]
mod sid_text;
#[path = "sid_win32.rs"]
#[allow(dead_code)]
mod sid_win32;
#[path = "tier.rs"]
#[allow(dead_code)]
mod tier;
#[path = "tier_bootstrap/mod.rs"]
#[allow(dead_code)]
mod tier_bootstrap;
#[path = "tier_desktop_policy.rs"]
#[allow(dead_code)]
mod tier_desktop_policy;
#[path = "tier_handoff.rs"]
#[allow(dead_code)]
mod tier_handoff;
#[path = "token_info.rs"]
#[allow(dead_code)]
mod token_info;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(tier_bootstrap::run(&args) as i32);
}

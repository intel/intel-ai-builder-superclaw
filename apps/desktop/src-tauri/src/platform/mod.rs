#[cfg(not(windows))]
mod unix;
#[cfg(windows)]
mod enterprise_probe;
#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
pub use unix::{command_for_program, configure_hidden};
#[cfg(windows)]
pub use windows::{command_for_program, configure_hidden, release_alt_key};
#[cfg(windows)]
pub use enterprise_probe::enterprise_probe_resolves;

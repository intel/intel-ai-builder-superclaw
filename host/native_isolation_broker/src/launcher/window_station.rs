//! The refusal of a tier launch from a window station other than `WinSta0` (#3292).
//!
//! A scheduled task or a service in Session 0 runs the launcher on a non-interactive window station.
//! The Secondary Logon service grants a new logon access to the caller's window station and desktop on
//! `WinSta0` and not there, so the tier logon succeeds and the runner then dies loading `user32` with
//! `STATUS_DLL_INIT_FAILED`, before it connects a pipe. Starting it anyway would mean changing the
//! security of a window station the launcher did not create, which the launcher never does. The owner
//! hop refuses instead, once the request is valid and its owner is bound and before anything touches a
//! root, an account or a credential, so an unsupported host is never reported as a provisioning
//! problem.
//!
//! The predicate is the window station's name and not the session id, because the name is what
//! decides whether the runner gets that grant. A name that cannot be read is refused as well, never
//! launched.
//!
//! Only `--launch-tier` asks. `--tier-loopback-self-test` starts its runner in its own account, which
//! needs no grant, and keeps running on CI runners in Session 0.

use super::refusal::{RefusalContext, TierLaunchRefusal, TierLaunchRefusalReason, refuse};
use std::io;
use windows_sys::Win32::System::StationsAndDesktops::{
    GetProcessWindowStation, GetUserObjectInformationW, UOI_NAME,
};

const INTERACTIVE_WINDOW_STATION: &str = "WinSta0";

const OUTSIDE_INTERACTIVE_WINDOW_STATION: &str = "tier roles start only from a logged-on \
                                                  interactive session (`WinSta0`); start SuperClaw \
                                                  from the signed-in desktop";

/// Refuses the launch as `windows_api_failure` unless this process runs on `WinSta0`.
pub(super) fn require_interactive_window_station(context: &RefusalContext<'_>) -> io::Result<()> {
    match station_refusal(current_window_station()) {
        None => Ok(()),
        Some(refusal) => Err(refuse(context, refusal)),
    }
}

/// The refusal for a launcher on `station`, or `None` on `WinSta0`.
fn station_refusal(station: io::Result<String>) -> Option<TierLaunchRefusal> {
    let detail = match station {
        Ok(name) if is_interactive_window_station(&name) => return None,
        Ok(_) => OUTSIDE_INTERACTIVE_WINDOW_STATION.to_owned(),
        Err(error) => format!(
            "the launcher's window station could not be read ({error}); \
             {OUTSIDE_INTERACTIVE_WINDOW_STATION}"
        ),
    };
    Some(TierLaunchRefusal::new(
        TierLaunchRefusalReason::WindowsApiFailure,
        detail,
    ))
}

fn is_interactive_window_station(station: &str) -> bool {
    station.eq_ignore_ascii_case(INTERACTIVE_WINDOW_STATION)
}

/// The name of this process's window station.
fn current_window_station() -> io::Result<String> {
    let mut buffer = [0u16; 256];
    let mut needed = 0;
    // SAFETY: The handle is this process's own window station, which must not be closed, and the
    // buffer length passed is the buffer's size in bytes.
    let read = unsafe {
        GetUserObjectInformationW(
            GetProcessWindowStation(),
            UOI_NAME,
            buffer.as_mut_ptr().cast(),
            size_of_val(&buffer) as u32,
            &mut needed,
        )
    };
    if read == 0 {
        return Err(io::Error::last_os_error());
    }
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16(&buffer[..length]).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "window station name is not UTF-16",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_winsta0_in_any_case_is_the_interactive_window_station() {
        assert!(is_interactive_window_station("WinSta0"));
        assert!(is_interactive_window_station("winsta0"));
        assert!(is_interactive_window_station("WINSTA0"));
        assert!(!is_interactive_window_station("Service-0x0-3e7$"));
        assert!(!is_interactive_window_station("Service-0x0-6ee570$"));
        assert!(!is_interactive_window_station(r"WinSta0\Default"));
        assert!(!is_interactive_window_station(""));
    }

    #[test]
    fn a_launcher_on_winsta0_is_not_refused() {
        assert!(station_refusal(Ok("WinSta0".to_owned())).is_none());
    }

    #[test]
    fn a_launcher_on_another_window_station_is_refused_with_the_host_prerequisite() {
        let Some(refusal) = station_refusal(Ok("Service-0x0-3e7$".to_owned())) else {
            panic!("a non-interactive window station must be refused");
        };
        assert_eq!(refusal.reason, TierLaunchRefusalReason::WindowsApiFailure);
        assert_eq!(
            refusal.detail,
            "tier roles start only from a logged-on interactive session (`WinSta0`); start \
             SuperClaw from the signed-in desktop"
        );
    }

    #[test]
    fn a_window_station_that_cannot_be_read_is_refused_and_not_launched() {
        let Some(refusal) = station_refusal(Err(io::Error::from_raw_os_error(6))) else {
            panic!("an unreadable window station must be refused");
        };
        assert_eq!(refusal.reason, TierLaunchRefusalReason::WindowsApiFailure);
        assert!(
            refusal
                .detail
                .starts_with("the launcher's window station could not be read ("),
            "{}",
            refusal.detail
        );
        assert!(refusal.detail.ends_with(OUTSIDE_INTERACTIVE_WINDOW_STATION));
    }

    #[test]
    fn this_process_has_a_window_station_name() {
        assert!(!current_window_station().expect("name").is_empty());
    }
}

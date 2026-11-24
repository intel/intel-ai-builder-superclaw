//! Read-only observation of the Secondary Logon service, for diagnosis only.
//!
//! `CreateProcessWithLogonW` is implemented by `seclogon`, so an image where that service is disabled
//! cannot perform the first hop at all. A stopped Manual service is not such a condition: the call
//! demand-starts it. 启动权威 §3.6 names this as one of the two new environment dependencies the
//! two-hop design takes on, and requires it to surface as an actionable refusal rather than as a raw
//! Win32 code the caller has to look up.
//!
//! # This never gates a launch
//!
//! The service state is read *after* a logon attempt has already failed, purely to turn an
//! unclassified failure into a specific one. Checking first would be both a race - the service is
//! demand-started, so "stopped" a millisecond before a successful logon is normal - and a second
//! failure mode of its own, since the query can fail on a hardened image where the launch would have
//! worked. Every path here therefore degrades to `Unknown` and lets the original error stand.
//!
//! Nothing in this module can change a service. `SC_MANAGER_CONNECT` and `SERVICE_QUERY_STATUS` are
//! the two narrowest rights that answer the question, both available to any authenticated caller;
//! there is no `SERVICE_START`, no `SERVICE_STOP` and no `SERVICE_CHANGE_CONFIG` here, so the
//! unelevated launcher cannot repair what it diagnoses. Restoring the service is an operator action,
//! which is what the refusal text asks for.

use crate::wide::to_wide;
use std::io;
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SC_HANDLE,
    SC_MANAGER_CONNECT, SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START_PENDING,
    SERVICE_STATUS,
};

/// The service name of Secondary Logon. Its display name is localized; this one is not.
const SECLOGON_SERVICE_NAME: &str = "seclogon";

/// What the service control manager says about `seclogon`.
pub enum SeclogonState {
    /// Running, or starting up. A demand-started service is often observed mid-transition, and both
    /// states mean the same thing for diagnosis: this is not the reason the logon failed.
    Available,
    /// The service exists and is not running, carrying its `dwCurrentState`.
    NotRunning(u32),
    /// The state could not be determined, carrying why. Absence of an answer is never evidence.
    Unknown(io::Error),
}

impl SeclogonState {
    /// Whether the service can be ruled out as the cause. `Unknown` counts as ruled out on purpose:
    /// blaming the service because its state could not be read would replace a true error with a
    /// guess.
    pub fn rules_out_seclogon(&self) -> bool {
        !matches!(self, Self::NotRunning(_))
    }

    /// One clause naming the observed state, for a refusal detail.
    pub fn describe(&self) -> String {
        match self {
            Self::Available => "the Secondary Logon service is running".to_owned(),
            Self::NotRunning(state) => format!(
                "the Secondary Logon service (seclogon) is not running (current state {state})"
            ),
            Self::Unknown(error) => {
                format!("the Secondary Logon service state could not be read ({error})")
            }
        }
    }
}

/// Reads `seclogon`'s current state. Never fails: every failure becomes `Unknown`.
pub fn seclogon_state() -> SeclogonState {
    match query_seclogon() {
        Err(error) => SeclogonState::Unknown(error),
        Ok(state) if state == SERVICE_RUNNING || state == SERVICE_START_PENDING => {
            SeclogonState::Available
        }
        Ok(state) => SeclogonState::NotRunning(state),
    }
}

fn query_seclogon() -> io::Result<u32> {
    // SAFETY: A null machine name and database name select the local, active database, which is what
    // the two null arguments document.
    let manager = OwnedServiceHandle::new(unsafe {
        OpenSCManagerW(std::ptr::null(), std::ptr::null(), SC_MANAGER_CONNECT)
    })?;
    let name = to_wide(SECLOGON_SERVICE_NAME);
    // SAFETY: `manager` is open for the duration of the call and `name` is NUL-terminated.
    let service = OwnedServiceHandle::new(unsafe {
        OpenServiceW(manager.raw(), name.as_ptr(), SERVICE_QUERY_STATUS)
    })?;
    let mut status = SERVICE_STATUS::default();
    // SAFETY: `service` is open and `status` is a writable out-parameter of the required type.
    if unsafe { QueryServiceStatus(service.raw(), &mut status) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(status.dwCurrentState)
}

/// An `SC_HANDLE` closed with `CloseServiceHandle` rather than `CloseHandle`, which is a different
/// function for this handle type and the reason this wrapper is not `OwnedHandle`.
struct OwnedServiceHandle(SC_HANDLE);

impl OwnedServiceHandle {
    fn new(handle: SC_HANDLE) -> io::Result<Self> {
        if handle.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(handle))
        }
    }

    fn raw(&self) -> SC_HANDLE {
        self.0
    }
}

impl Drop for OwnedServiceHandle {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a non-null handle from `OpenSCManagerW` or `OpenServiceW`, closed once.
        unsafe {
            CloseServiceHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The query runs unelevated on a stock image and answers without a privilege. There is no
    /// assertion on *which* state comes back: a machine where the operator has disabled Secondary
    /// Logon is a legitimate machine, and this suite must not fail on it. What is asserted is that the
    /// call terminates with a describable answer and that the answer is self-consistent.
    #[test]
    fn the_service_state_is_readable_without_a_privilege_and_always_describable() {
        let state = seclogon_state();
        let text = state.describe();
        assert!(!text.is_empty());
        match &state {
            SeclogonState::Available => assert!(state.rules_out_seclogon()),
            SeclogonState::NotRunning(_) => {
                assert!(!state.rules_out_seclogon());
                assert!(text.contains("seclogon"));
            }
            // An unreadable state must never be reported as evidence against the service.
            SeclogonState::Unknown(_) => assert!(state.rules_out_seclogon()),
        }
    }
}

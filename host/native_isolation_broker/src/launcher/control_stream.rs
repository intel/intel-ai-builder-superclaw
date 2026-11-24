//! Sandbox Manager's persistent standard-input control stream and startup report.

use super::wire::{
    LAUNCHER_CONTRACT_VERSION, TierFrame, TierLaunchStartedReport, read_frame, read_optional_frame,
};
use crate::tier::IsolationTier;
use crate::zeroize::wipe;
use serde_json::Value;
use std::io::{self, Read, Write};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Storage::FileSystem::WriteFile;

/// Reads the initial framed catalog request and refuses every non-object JSON shape.
pub(super) fn read_start_request(reader: &mut impl Read) -> io::Result<Value> {
    let payload = read_frame(reader)?;
    let request: Value = serde_json::from_slice(&payload).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the start request is not a JSON object: {error}"),
        )
    })?;
    if !request.is_object() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the start request must be a JSON object",
        ));
    }
    Ok(request)
}

/// Waits for the sole post-start command. EOF has the same teardown meaning as Stop so an
/// unexpectedly terminated Sandbox Manager cannot leave a role tree behind.
pub(super) fn wait_for_stop(reader: &mut impl Read) -> io::Result<()> {
    let Some(payload) = read_optional_frame(reader)? else {
        return Ok(());
    };
    let value: Value = serde_json::from_slice(&payload).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("the launcher control frame is not valid JSON: {error}"),
        )
    })?;
    if value != serde_json::json!({"op": "stop"}) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the only launcher control frame after start is an empty stop frame",
        ));
    }
    Ok(())
}

pub(super) struct StartedReport<'a> {
    pub launch_path: &'a str,
    pub tier: IsolationTier,
    pub owner_sid: &'a str,
    pub runner_sid: &'a str,
    pub launch_role: &'a str,
    pub runner_pid: u32,
}

pub(super) fn write_started_report(
    context: StartedReport<'_>,
    started: &TierFrame,
) -> io::Result<()> {
    let TierFrame::Started { role_pid, .. } = started else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the runner did not provide a started frame",
        ));
    };
    let report = TierLaunchStartedReport {
        contract_version: LAUNCHER_CONTRACT_VERSION,
        event: "tier_launch_started".to_owned(),
        launch_path: context.launch_path.to_owned(),
        tier: context.tier.as_str().to_owned(),
        owner_sid: context.owner_sid.to_owned(),
        runner_sid: context.runner_sid.to_owned(),
        launch_role: context.launch_role.to_owned(),
        runner_pid: context.runner_pid,
        role_pid: *role_pid,
    };
    let line = serde_json::to_string(&report).map_err(|error| {
        io::Error::other(format!("launch started report does not serialize: {error}"))
    })?;
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{line}")?;
    stdout.flush()
}

pub(super) fn write_connector_client_config(handle: usize, payload: &[u8]) -> io::Result<()> {
    if payload.is_empty() || payload.len() > crate::launch_spec::CONNECTOR_CLIENT_PAYLOAD_MAX_BYTES
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Connector client configuration is outside its transfer bound",
        ));
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(payload);
    let raw = handle as HANDLE;
    let mut written = 0;
    // SAFETY: the handle is an inherited anonymous-pipe writer supplied only for this Connector
    // launch; the buffer remains live for the synchronous write and the handle is closed below.
    let result = unsafe {
        WriteFile(
            raw,
            frame.as_ptr().cast(),
            frame.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        )
    };
    wipe(&mut frame);
    // SAFETY: this process owns the inherited handle and transfers no further copy.
    unsafe { CloseHandle(raw) };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    if written as usize != frame.len() {
        return Err(io::Error::new(
            io::ErrorKind::WriteZero,
            "Connector client configuration was only partially transferred",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launcher::wire::encode_frame;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::Pipes::CreatePipe;

    #[test]
    fn a_start_request_frame_must_be_a_json_object() {
        let framed = |payload: &[u8]| encode_frame(payload).expect("frame should encode");
        assert!(read_start_request(&mut framed(b"{\"launch_role\":\"x\"}").as_slice()).is_ok());
        for rejected in [&b"[1,2,3]"[..], b"\"text\"", b"7", b"not json"] {
            assert_eq!(
                read_start_request(&mut framed(rejected).as_slice())
                    .expect_err("only a JSON object is a start request")
                    .kind(),
                io::ErrorKind::InvalidData,
                "accepted {}",
                String::from_utf8_lossy(rejected)
            );
        }
    }

    #[test]
    fn connector_client_config_is_one_length_frame_and_closes_its_writer() {
        let mut reader = std::ptr::null_mut();
        let mut writer = std::ptr::null_mut();
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 0,
        };
        // SAFETY: output pointers and attributes remain valid for the call.
        assert_ne!(
            unsafe { CreatePipe(&mut reader, &mut writer, &attributes, 0) },
            0
        );
        let payload = b"{\"contract_version\":1}";
        write_connector_client_config(writer as usize, payload).expect("frame should write");
        let mut file =
            std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_handle(reader) });
        let mut frame = Vec::new();
        file.read_to_end(&mut frame)
            .expect("writer close should produce EOF");
        // SAFETY: ManuallyDrop prevented File from owning the raw handle; close it exactly once here.
        unsafe { CloseHandle(reader) };
        assert_eq!(&frame[..4], &(payload.len() as u32).to_le_bytes());
        assert_eq!(&frame[4..], payload);
    }
}

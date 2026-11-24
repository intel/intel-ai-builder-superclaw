use crate::protocol::{
    Action, AllowlistedTarget, PROTOCOL_VERSION, Request, Response, sign_request,
};
use crate::sid_win32::current_process_sid;
use crate::win32::{PipeClient, ProcessWitness};
use std::io;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SELF_TEST_KEY: [u8; 32] = [
    0x71, 0x34, 0xa9, 0x02, 0x53, 0xc1, 0x7e, 0x88, 0xd4, 0x6b, 0x2f, 0x91, 0x0a, 0xed, 0x55, 0xbc,
    0x38, 0x60, 0x19, 0xf7, 0x42, 0x85, 0xcd, 0x13, 0xea, 0x9c, 0x06, 0xb1, 0x64, 0x27, 0xdf, 0x4e,
];

struct ServerProcess {
    child: Child,
}

impl ServerProcess {
    fn spawn(pipe_id: &str, owner_sid: &str) -> io::Result<Self> {
        let executable = std::env::current_exe()?;
        let child = Command::new(executable)
            .args([
                "--test-server",
                "--pipe-id",
                pipe_id,
                "--owner-sid",
                owner_sid,
                "--auth-key",
                &hex::encode(SELF_TEST_KEY),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()?;
        Ok(Self { child })
    }

    fn wait_success(&mut self, timeout: Duration) -> io::Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(io::Error::other(format!(
                        "test server exited with {status}"
                    )))
                };
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "test server did not exit",
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn kill_and_wait(&mut self) -> io::Result<()> {
        self.child.kill()?;
        self.child.wait()?;
        Ok(())
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

pub fn run() -> io::Result<()> {
    let owner_sid = current_process_sid()?;
    release_proof(&owner_sid)?;
    timeout_proof(&owner_sid)?;
    pipe_loss_proof(&owner_sid)?;
    broker_exit_proof(&owner_sid)?;
    println!("{{\"ok\":true,\"phase\":\"self_test_complete\",\"error_code\":\"none\"}}");
    Ok(())
}

fn release_proof(owner_sid: &str) -> io::Result<()> {
    let pipe_id = unique_pipe_id("release");
    let mut server = ServerProcess::spawn(&pipe_id, owner_sid)?;
    let client = PipeClient::connect(&pipe_id, Duration::from_secs(5))?;

    let acquire = signed_request(
        1,
        owner_sid,
        "release-acquire-0001",
        Action::Acquire {
            lease_id: "release-lease".to_owned(),
            target: AllowlistedTarget::FixedSleepChild,
            timeout_ms: 2_000,
        },
    )?;
    let running = client.exchange(&acquire)?;
    let child_pid = require_running_verified(&running)?;
    let child = ProcessWitness::open(child_pid)?;

    let release = signed_request(
        2,
        owner_sid,
        "release-finish-0002",
        Action::Release {
            lease_id: "release-lease".to_owned(),
        },
    )?;
    let released = client.exchange(&release)?;
    if !released.ok || released.phase != "released" || released.child_pid != Some(child_pid) {
        return Err(invalid_response("release", &released));
    }
    server.wait_success(Duration::from_secs(5))?;
    if !child.has_exited(Duration::from_secs(2)) {
        return Err(io::Error::other(
            "fixed test child survived explicit lease release",
        ));
    }
    Ok(())
}

fn timeout_proof(owner_sid: &str) -> io::Result<()> {
    let pipe_id = unique_pipe_id("timeout");
    let mut server = ServerProcess::spawn(&pipe_id, owner_sid)?;
    let client = PipeClient::connect(&pipe_id, Duration::from_secs(5))?;

    let acquire = signed_request(
        3,
        owner_sid,
        "timeout-acquire-0003",
        Action::Acquire {
            lease_id: "timeout-lease".to_owned(),
            target: AllowlistedTarget::FixedSleepChild,
            timeout_ms: 350,
        },
    )?;
    let running = client.exchange(&acquire)?;
    let child_pid = require_running_verified(&running)?;
    let child = ProcessWitness::open(child_pid)?;

    server.wait_success(Duration::from_secs(5))?;
    if !child.has_exited(Duration::from_secs(2)) {
        return Err(io::Error::other("fixed test child survived lease timeout"));
    }
    Ok(())
}

fn pipe_loss_proof(owner_sid: &str) -> io::Result<()> {
    let pipe_id = unique_pipe_id("pipe-loss");
    let mut server = ServerProcess::spawn(&pipe_id, owner_sid)?;
    let client = PipeClient::connect(&pipe_id, Duration::from_secs(5))?;

    let acquire = signed_request(
        4,
        owner_sid,
        "pipe-loss-acquire-0004",
        Action::Acquire {
            lease_id: "pipe-loss-lease".to_owned(),
            target: AllowlistedTarget::FixedSleepChild,
            timeout_ms: 2_000,
        },
    )?;
    let running = client.exchange(&acquire)?;
    let child_pid = require_running_verified(&running)?;
    let child = ProcessWitness::open(child_pid)?;

    drop(client);
    server.wait_success(Duration::from_secs(5))?;
    if !child.has_exited(Duration::from_secs(2)) {
        return Err(io::Error::other(
            "fixed test child survived named-pipe client loss",
        ));
    }
    Ok(())
}

fn broker_exit_proof(owner_sid: &str) -> io::Result<()> {
    let pipe_id = unique_pipe_id("broker-exit");
    let mut server = ServerProcess::spawn(&pipe_id, owner_sid)?;
    let client = PipeClient::connect(&pipe_id, Duration::from_secs(5))?;

    let acquire = signed_request(
        5,
        owner_sid,
        "broker-exit-acquire-0005",
        Action::Acquire {
            lease_id: "broker-exit-lease".to_owned(),
            target: AllowlistedTarget::FixedSleepChild,
            timeout_ms: 2_000,
        },
    )?;
    let running = client.exchange(&acquire)?;
    let child_pid = require_running_verified(&running)?;
    let child = ProcessWitness::open(child_pid)?;

    server.kill_and_wait()?;
    drop(client);
    if !child.has_exited(Duration::from_secs(2)) {
        return Err(io::Error::other(
            "fixed test child survived broker process death",
        ));
    }
    Ok(())
}

fn signed_request(
    request_id: u64,
    owner_sid: &str,
    nonce: &str,
    action: Action,
) -> io::Result<Request> {
    let mut request = Request {
        version: PROTOCOL_VERSION,
        request_id,
        owner_sid: owner_sid.to_owned(),
        nonce: nonce.to_owned(),
        action,
        mac: String::new(),
    };
    sign_request(&mut request, &SELF_TEST_KEY)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.code()))?;
    Ok(request)
}

fn require_running_verified(response: &Response) -> io::Result<u32> {
    if response.ok && response.phase == "running_verified" {
        response
            .child_pid
            .ok_or_else(|| invalid_response("acquire child PID", response))
    } else {
        Err(invalid_response("acquire", response))
    }
}

fn invalid_response(operation: &str, response: &Response) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("{operation} returned unexpected response: {response:?}"),
    )
}

fn unique_pipe_id(label: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{label}-{}-{nanos:x}", std::process::id())
}

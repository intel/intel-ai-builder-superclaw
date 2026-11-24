//! What crosses from the tier bootstrap (#3499, #3400): its own command line, the supervisor's, and the
//! one handoff frame it sends the owner.
//!
//! # Why this module is shared and small
//!
//! Three binaries agree on these shapes: the owner-side launcher builds the bootstrap's command line and
//! reads its frame, the bootstrap parses the one and writes the other, and the supervisor it starts is the
//! launcher's `--tier-runner` mode. Each shape has one definition here, with no Win32 surface, so the
//! bootstrap's module closure can include it without reaching the launcher's.
//!
//! # The frame
//!
//! One frame, bootstrap to owner, carrying four handle values that are only meaningful inside the
//! bootstrap and the supervisor's process id. The owner duplicates the handles through the bootstrap
//! process handle it kept from creation and verifies every object it gets before using it, so the
//! values are claims to check rather than facts to adopt. It is a closed, strictly typed struct under a
//! per-boundary byte bound, authenticated like the other tier frames with the launch's key and bound to
//! the tier. It carries no path, command line, name or free-form text.

use crate::frame::{self, FrameError};
use crate::sid_text::validate_sid_text;
use crate::tier::IsolationTier;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

/// The bootstrap image, beside the launcher in the payload's `native-isolation` directory.
pub const BOOTSTRAP_IMAGE: &str = "native_isolation_tier_bootstrap.exe";

/// The supervisor's image, which is the launcher itself in its `--tier-runner` mode.
pub const LAUNCHER_IMAGE: &str = "native_isolation_launcher.exe";

/// The handoff pipe's role suffix. `launcher::pipe_acl` names the pipe with the same suffix and its tests
/// pin the two names to each other.
pub const HANDOFF_PIPE_SUFFIX: &str = "handoff";

/// The tier pipe namespace, the same one `launcher::pipe_acl::TIER_PIPE_PREFIX` names.
const HANDOFF_PIPE_PREFIX: &str = r"\\.\pipe\SuperClawTierRunner-";

/// `FILE_WRITE_DATA` plus the NPFS open floor: the one right the bootstrap opens the handoff pipe with,
/// equal to `launcher::pipe_acl::TIER_WRITE_RIGHTS`.
pub const HANDOFF_CLIENT_RIGHTS: u32 = 0x0010_0082;

/// The handoff boundary's own frame bound. A sealed frame is a few hundred bytes.
pub const MAX_HANDOFF_FRAME_BYTES: usize = 1024;

pub const HANDOFF_VERSION: u32 = 1;

/// Owner-side spike selector. Only the owner reads the environment; the bootstrap receives the
/// resulting decision as a closed command-line switch.
pub const ROLE_DESKTOP_BOUNDARY_ENV: &str = "SUPERCLAW_NATIVE_ROLE_DESKTOP_BOUNDARY";
const ROLE_DESKTOP_BOUNDARY_ARG: &str = "--role-desktop-boundary";

pub fn bootstrap_role_desktop_boundary(args: &[String]) -> bool {
    args.last().is_some_and(|arg| arg == ROLE_DESKTOP_BOUNDARY_ARG)
}

/// Separates this MAC from every other one made with the same launch key.
const DOMAIN: &[u8] = b"superclaw.tier-handoff.v1\0";

/// The exit code the owner ends the bootstrap with once it holds everything the bootstrap reported.
pub const BOOTSTRAP_RELEASED_EXIT_CODE: u32 = 0x5343_4252;

/// The base of the bootstrap's failure codes; a step's code is this plus its position.
const BOOTSTRAP_STEP_EXIT_BASE: u32 = 0x5343_4200;

/// The 32 lowercase hex digits of a launch's pipe id (`owner::PIPE_ID_BYTES` random bytes).
pub const PIPE_ID_HEX_LEN: usize = 32;

/// The bootstrap's own arguments, all of them derived by the owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapArgs {
    pub tier: IsolationTier,
    pub pipe_id: String,
    pub key_hex: String,
    pub owner_sid: String,
    pub role_desktop_boundary: bool,
}

/// The bootstrap's command line. It names no program and no path but its own image.
pub fn bootstrap_command_line(bootstrap: &Path, args: &BootstrapArgs) -> String {
    let base = format!(
        "\"{}\" --tier {} --pipe-id {} --auth-key {} --owner-sid {}",
        bootstrap.display(),
        args.tier.as_str(),
        args.pipe_id,
        args.key_hex,
        args.owner_sid
    );
    if args.role_desktop_boundary {
        format!("{base} {ROLE_DESKTOP_BOUNDARY_ARG}")
    } else {
        base
    }
}

/// Parses the closed owner-built bootstrap argument set, optionally with the spike switch last.
pub fn parse_bootstrap_args(args: &[String]) -> io::Result<BootstrapArgs> {
    parse_bootstrap_args_after_boundary_check(args, bootstrap_role_desktop_boundary(args))
}

/// Parses the closed set after the bootstrap's first instruction has already read the final switch.
pub fn parse_bootstrap_args_after_boundary_check(
    args: &[String],
    role_desktop_boundary: bool,
) -> io::Result<BootstrapArgs> {
    let refused = |what: &str| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("the tier bootstrap refuses its command line: {what}"),
        )
    };
    let base = match (role_desktop_boundary, args) {
        (true, [base @ .., flag]) if flag == ROLE_DESKTOP_BOUNDARY_ARG => base,
        (true, _) => return Err(refused("the boundary switch is not the final argument")),
        (false, base) => base,
    };
    let [
        tier_flag,
        tier,
        pipe_flag,
        pipe_id,
        key_flag,
        key_hex,
        owner_flag,
        owner_sid,
    ] = base
    else {
        return Err(refused("expected exactly four flags and their values"));
    };
    if tier_flag != "--tier"
        || pipe_flag != "--pipe-id"
        || key_flag != "--auth-key"
        || owner_flag != "--owner-sid"
    {
        return Err(refused("the flags are not the closed set in order"));
    }
    let tier = IsolationTier::from_wire(tier).ok_or_else(|| refused("unknown tier"))?;
    if !is_pipe_id(pipe_id) {
        return Err(refused("the pipe id is not 32 lowercase hex digits"));
    }
    frame::decode_auth_key(key_hex).map_err(|_| refused("the key is not 32 bytes of hex"))?;
    validate_sid_text(owner_sid).map_err(|_| refused("the owner SID is not a SID"))?;
    Ok(BootstrapArgs {
        tier,
        pipe_id: pipe_id.clone(),
        key_hex: key_hex.clone(),
        owner_sid: owner_sid.clone(),
        role_desktop_boundary,
    })
}

fn is_pipe_id(value: &str) -> bool {
    value.len() == PIPE_ID_HEX_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The supervisor's command line: the launcher's `--tier-runner` mode, with the tier, the pipe id and the
/// key and nothing else.
pub fn runner_command_line(launcher: &Path, tier: &str, pipe_id: &str, key_hex: &str) -> String {
    format!(
        "\"{}\" --tier-runner --tier {tier} --pipe-id {pipe_id} --auth-key {key_hex}",
        launcher.display()
    )
}

/// The handoff pipe's name for one launch. The id rule is `launcher::pipe_acl::pipe_name`'s.
pub fn handoff_pipe_name(pipe_id: &str) -> io::Result<String> {
    if pipe_id.is_empty()
        || pipe_id.len() > 64
        || !pipe_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "pipe ID must be 1-64 ASCII letters, digits, '-' or '_'",
        ));
    }
    Ok(format!(
        "{HANDOFF_PIPE_PREFIX}{pipe_id}-{HANDOFF_PIPE_SUFFIX}"
    ))
}

/// What the bootstrap reports. The four handles are values in the bootstrap's own handle table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Handoff {
    pub station_handle: u64,
    pub desktop_handle: u64,
    pub supervisor_pid: u32,
    pub supervisor_process_handle: u64,
    pub supervisor_thread_handle: u64,
}

impl Handoff {
    /// A handle value is a non-zero multiple of four that fits in 32 bits, and a process id is non-zero.
    /// A value that is not cannot denote what it claims.
    fn check(&self) -> Result<(), HandoffError> {
        let handle =
            |value: u64| value != 0 && value.is_multiple_of(4) && value <= u64::from(u32::MAX);
        let valid = handle(self.station_handle)
            && handle(self.desktop_handle)
            && handle(self.supervisor_process_handle)
            && handle(self.supervisor_thread_handle)
            && self.supervisor_pid != 0;
        if valid {
            Ok(())
        } else {
            Err(FrameError::InvalidField.into())
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    tier: String,
    nonce: String,
    handoff: Handoff,
    mac: String,
}

/// Why a handoff frame was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoffError {
    Frame(FrameError),
    TierMismatch,
}

impl HandoffError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Frame(error) => error.code(),
            Self::TierMismatch => "tier_mismatch",
        }
    }
}

impl From<FrameError> for HandoffError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl From<HandoffError> for io::Error {
    fn from(error: HandoffError) -> Self {
        Self::new(
            io::ErrorKind::InvalidData,
            format!("tier handoff frame refused: {}", error.code()),
        )
    }
}

/// Seals one handoff for `tier` under the launch key.
pub fn seal(
    handoff: &Handoff,
    tier: &str,
    nonce: String,
    key: &[u8],
) -> Result<Vec<u8>, HandoffError> {
    handoff.check()?;
    frame::validate_nonce(&nonce)?;
    let mac = frame::mac_hex(&authenticated(HANDOFF_VERSION, tier, &nonce, handoff)?, key)?;
    Ok(frame::encode_body(
        &Envelope {
            version: HANDOFF_VERSION,
            tier: tier.to_owned(),
            nonce,
            handoff: *handoff,
            mac,
        },
        MAX_HANDOFF_FRAME_BYTES,
    )?)
}

/// The bytes the MAC covers: a domain tag, then the frame minus its `mac`. Serialized from a struct, so
/// the field order is the declaration's and not a map's.
fn authenticated(
    version: u32,
    tier: &str,
    nonce: &str,
    handoff: &Handoff,
) -> Result<Vec<u8>, HandoffError> {
    #[derive(Serialize)]
    struct Authenticated<'a> {
        version: u32,
        tier: &'a str,
        nonce: &'a str,
        handoff: &'a Handoff,
    }
    let mut bytes = DOMAIN.to_vec();
    serde_json::to_writer(
        &mut bytes,
        &Authenticated {
            version,
            tier,
            nonce,
            handoff,
        },
    )
    .map_err(|_| FrameError::InvalidJson)?;
    Ok(bytes)
}

/// Opens one handoff frame body, refusing anything but a well-formed, authenticated frame for `tier`.
///
/// Everything decidable from the bytes is decided before the MAC, and the values are checked after it,
/// so a forged frame is refused for its MAC and a genuine but impossible one for its values.
pub fn open(body: &[u8], tier: &str, key: &[u8]) -> Result<Handoff, HandoffError> {
    if body.len() > MAX_HANDOFF_FRAME_BYTES {
        return Err(FrameError::Oversized.into());
    }
    let envelope: Envelope = serde_json::from_slice(body).map_err(|_| FrameError::InvalidJson)?;
    if envelope.version != HANDOFF_VERSION {
        return Err(FrameError::UnsupportedVersion.into());
    }
    frame::validate_nonce(&envelope.nonce)?;
    if envelope.tier != tier {
        return Err(HandoffError::TierMismatch);
    }
    frame::verify_mac_hex(
        &authenticated(
            envelope.version,
            &envelope.tier,
            &envelope.nonce,
            &envelope.handoff,
        )?,
        &envelope.mac,
        key,
    )?;
    envelope.handoff.check()?;
    Ok(envelope.handoff)
}

/// The bootstrap's steps, in order. A bootstrap that fails exits with its step's code, so the owner's
/// refusal can name the step without the bootstrap sending anything but the one frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapStep {
    DefaultDacl,
    ThreadProtection,
    ErrorMode,
    Arguments,
    LoadUser32,
    Station,
    Desktop,
    RestrictedToken,
    Supervisor,
    HandoffConnect,
    HandoffSend,
    Release,
}

impl BootstrapStep {
    pub const ALL: [Self; 12] = [
        Self::DefaultDacl,
        Self::ThreadProtection,
        Self::ErrorMode,
        Self::Arguments,
        Self::LoadUser32,
        Self::Station,
        Self::Desktop,
        Self::RestrictedToken,
        Self::Supervisor,
        Self::HandoffConnect,
        Self::HandoffSend,
        Self::Release,
    ];

    pub const fn exit_code(self) -> u32 {
        BOOTSTRAP_STEP_EXIT_BASE + 1 + self as u32
    }

    pub fn from_exit_code(code: u32) -> Option<Self> {
        Self::ALL.into_iter().find(|step| step.exit_code() == code)
    }

    pub const fn describe(self) -> &'static str {
        match self {
            Self::DefaultDacl => "the bootstrap could not set and verify its token's default DACL",
            Self::ThreadProtection => "the bootstrap could not protect and verify its threads",
            Self::ErrorMode => "the bootstrap could not set its error mode",
            Self::Arguments => "the bootstrap's arguments were refused",
            Self::LoadUser32 => "the bootstrap could not load user32",
            Self::Station => "the bootstrap could not create the private window station",
            Self::Desktop => "the bootstrap could not create the private desktop",
            Self::RestrictedToken => {
                "the bootstrap could not create the supervisor's restricted token"
            }
            Self::Supervisor => "the bootstrap could not start the restricted supervisor",
            Self::HandoffConnect => "the bootstrap could not open the handoff pipe",
            Self::HandoffSend => "the bootstrap could not send its handoff",
            Self::Release => "the owner did not release the bootstrap in time",
        }
    }
}

#[cfg(test)]
mod tests;

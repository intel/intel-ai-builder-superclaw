//! The closed launch spec a resolved catalog entry produces.
//!
//! It lives apart from the process-creation modules so both the privileged foreign-token path and
//! the unelevated same-account path can consume the same resolution result without either of them
//! having to link the other.
//!
//! Everything here is derived from the shipped catalog and the validated bindings of one start
//! request. No field is copied from a caller-supplied string: the caller binds typed placeholders and
//! this module decides what they turn into.

use crate::job::JobLimitProfile;
use crate::zeroize::ZeroizedBytes;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

/// The largest stdin payload a role may be handed.
///
/// Deliberately half of the Connector's own `_MAX_REQUEST_BYTES` (16 KiB, see
/// `host/sandbox_manager/src/sandbox_manager/connector.py`), so a payload this side accepts is one the
/// peer can still read: a bound equal to the peer's would make the two sides disagree at exactly the
/// boundary, where the peer refuses `> _MAX_REQUEST_BYTES` and this side would have already written.
///
/// It is larger than the pipe buffer the delivery goes through, which is the reason that delivery is a
/// bounded wait rather than a straight write - see `launcher::runner::deliver_stdin`. A bound small
/// enough to always fit the buffer would be an accidental coupling to a Win32 default; bounding the wait
/// instead keeps the two decisions apart.
pub const STDIN_PAYLOAD_MAX_BYTES: usize = 8 * 1024;

/// One bounded line written to a role's standard input and nowhere else.
///
/// The bytes are held in a `ZeroizedBytes` because the only payload that needs this today is the
/// Connector bootstrap, which carries two symmetric keys. What the container buys is narrow and worth
/// stating honestly: it bounds the window in which the plaintext sits in this process's heap. The
/// property that actually matters is structural - a stdin payload never reaches argv, an environment
/// block, a log or a temporary file, because it is reachable only through this type and the one write
/// in the tier runner.
pub struct StdinPayload(ZeroizedBytes);

impl StdinPayload {
    /// Accepts exactly one line: non-empty, bounded, with a single trailing newline and no interior
    /// one.
    ///
    /// The single-line shape is not a stylistic preference. The peer reads its request with one
    /// `readline`, so a payload with an interior newline would deliver a truncated request and leave
    /// the remainder in the pipe, and a payload with no newline at all would leave the peer blocked on
    /// a line that never ends. Refusing both here means the delivery site has nothing left to check.
    ///
    /// Refusals carry neither the payload nor its length. The bound is the actionable part, and the
    /// length is a fact about this crate's own code rather than about the machine the refusal came from,
    /// so printing it would say nothing an operator can use while describing a buffer that holds keys.
    pub fn single_line(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() > STDIN_PAYLOAD_MAX_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("a role stdin payload is over the {STDIN_PAYLOAD_MAX_BYTES} byte bound"),
            ));
        }
        match bytes.split_last() {
            Some((b'\n', head)) if !head.is_empty() && !head.contains(&b'\n') => {
                Ok(Self(ZeroizedBytes::copy_from(bytes)))
            }
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "a role stdin payload must be one non-empty line ending in a single newline",
            )),
        }
    }

    pub fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }
}

/// Bounded Connector client configuration that may travel only on the dedicated secret channel.
pub struct ConnectorClientPayload(ZeroizedBytes);

pub const CONNECTOR_CLIENT_PAYLOAD_MAX_BYTES: usize = 1024;

impl ConnectorClientPayload {
    pub fn from_json(bytes: &[u8]) -> io::Result<Self> {
        if bytes.is_empty()
            || bytes.len() > CONNECTOR_CLIENT_PAYLOAD_MAX_BYTES
            || bytes.contains(&b'\n')
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Connector client configuration is outside its bounded single-object shape",
            ));
        }
        Ok(Self(ZeroizedBytes::copy_from(bytes)))
    }

    pub fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl fmt::Debug for ConnectorClientPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConnectorClientPayload")
            .field("bytes", &self.0.as_slice().len())
            .finish()
    }
}

/// Redacting by hand rather than deriving, for the same reason `zeroize` implements no `Debug` at all: a
/// derived one would print two symmetric keys into any panic message or refusal that formatted a payload.
impl fmt::Debug for StdinPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StdinPayload")
            .field("bytes", &self.0.as_slice().len())
            .finish()
    }
}

/// Cloned through the same copying constructor the container uses, so a clone is a second buffer that
/// wipes itself rather than a shared one that wipes twice.
impl Clone for StdinPayload {
    fn clone(&self) -> Self {
        Self(ZeroizedBytes::copy_from(self.0.as_slice()))
    }
}

/// What a role receives on its standard input.
///
/// A description rather than the bytes, and that distinction is the whole point of the type. Both hops
/// resolve the same start request independently (`launcher::mod::resolve_request_for_tier`), so anything
/// a resolution *generates* is generated twice, in two processes. The Connector's bootstrap carries two
/// symmetric keys, and the owner hop has no business holding a copy of keys it will never deliver - so
/// resolution names the payload and the tier runner is the one place that mints it.
///
/// The consequence worth keeping: `resolve_validated_start` is a pure function of the validated request
/// for every role, which is what makes "the two hops agree" a property rather than a hope.
/// `catalog_start::tests::resolving_the_same_request_twice_gives_the_same_launch` pins it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoleStdin {
    /// Deterministic end-of-file, for a role with no inbound payload. The writer is closed immediately
    /// rather than left open, so a role that reads its input sees the end rather than blocking on bytes
    /// that are never coming.
    Eof,
    /// The Connector's bootstrap line, generated at delivery time from this search-module path.
    ConnectorBootstrap {
        search_module: PathBuf,
        endpoint: String,
    },
}

/// Everything a launch path is allowed to know about a role. The caller contributes none of it:
/// every field below is composed here from the shipped catalog and validated bindings.
#[derive(Clone)]
pub struct CatalogLaunchSpec {
    pub executable: PathBuf,
    pub command: String,
    /// The directory the role starts in, fixed by its role rather than derived from wherever the
    /// executable happens to sit. For the Connector it is load-bearing: `python -m` puts the working
    /// directory on `sys.path`, which is what makes `sandbox_manager.connector` importable without a
    /// `PYTHONPATH` entry.
    pub current_directory: PathBuf,
    pub job_profile: JobLimitProfile,
    /// Variables the catalog declares for this role. They are overlaid on the allowlisted base
    /// environment by `launch_environment`; anything not in the allowlist and not declared here
    /// does not reach the role. Only the same-account path applies this overlay today, because the
    /// foreign-token path must keep using the logon token's own environment block until it is
    /// removed (execution plan P8).
    pub environment: Vec<(String, String)>,
    /// What the role receives on its standard input, described rather than generated. See `RoleStdin`.
    pub stdin: RoleStdin,
    /// The tier's own log directory, `<state_logs_root>\<tier>`, derived during resolution.
    ///
    /// Only the directory, not the file: the file name comes from the launch's own random pipe
    /// identifier, which resolution does not have and must not be given. The tier runner combines the
    /// two through `role_log::RoleLogTarget`, so the one place that knows both is the one place that
    /// opens the file.
    pub log_directory: PathBuf,
}

impl fmt::Debug for CatalogLaunchSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CatalogLaunchSpec")
            .field("executable", &self.executable)
            .field("command", &self.command)
            .field("current_directory", &self.current_directory)
            .field("job_profile", &self.job_profile)
            .field(
                "environment_names",
                &self
                    .environment
                    .iter()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>(),
            )
            .field("stdin", &self.stdin)
            .field("log_directory", &self.log_directory)
            .finish()
    }
}

/// Builds the command line for a fixed program and its fixed arguments.
///
/// # Why this refuses instead of escaping
///
/// A Windows command line is one string, and every scheme for embedding a quote in it is a scheme for
/// getting the escaping subtly wrong - the CRT's backslash-doubling rule, `cmd.exe`'s caret rule and
/// each runtime's own parser disagree in the corners. This crate does not need any of them: every
/// argument it produces is a catalog literal, a canonical path or a validated number. So the rule is
/// that a quote, a control character or a trailing backslash is a bug in role resolution, refused here
/// rather than escaped into something whose meaning depends on who parses it.
///
/// A trailing backslash is refused for the one reason that is easy to miss: inside a quoted argument it
/// would escape the closing quote and swallow the next one, so `"C:\dir\" next` parses as a single
/// argument. Canonical paths never end in a separator, so nothing legitimate is lost.
pub fn command_line(executable: &Path, arguments: &[String]) -> io::Result<String> {
    let program = executable.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "a role executable path must be Unicode",
        )
    })?;
    let mut line = quote_argument(program)?;
    for argument in arguments {
        line.push(' ');
        line.push_str(&quote_argument(argument)?);
    }
    Ok(line)
}

/// Quotes one argument, or refuses it as unrepresentable.
///
/// Quoting is applied only where it changes the parse - an empty argument, or one containing a space - so
/// a command line reads as what it is and a test can assert the exact string a role receives. A tab is
/// the other separator `CreateProcessW` honours and is not quoted for, because the control-character
/// refusal above has already rejected it: one rule per character, and this one never sees a tab.
fn quote_argument(argument: &str) -> io::Result<String> {
    let refusal = |reason: &str| {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("a role argument {reason}"),
        ))
    };
    if argument.contains('"') {
        return refusal("must not contain a quotation mark");
    }
    if argument.chars().any(char::is_control) {
        return refusal("must not contain a control character");
    }
    if argument.ends_with('\\') {
        return refusal("must not end in a backslash");
    }
    if argument.is_empty() || argument.contains(' ') {
        return Ok(format!("\"{argument}\""));
    }
    Ok(argument.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_line_quotes_only_what_needs_it() {
        let line = command_line(
            Path::new(r"C:\Program Files\SuperClaw\payload\opencode.exe"),
            &[
                "serve".to_owned(),
                "--port".to_owned(),
                "4096".to_owned(),
                "--cors".to_owned(),
                "*".to_owned(),
                String::new(),
            ],
        )
        .expect("a fixed program and fixed arguments");
        assert_eq!(
            line,
            r#""C:\Program Files\SuperClaw\payload\opencode.exe" serve --port 4096 --cors * """#
        );
    }

    /// The whole reason resolution may assemble one string: an argument that could steer the parse is
    /// not escaped into something ambiguous, it is refused. The quote cases are the ones that matter -
    /// they are how a bound scalar would try to become a second argument.
    #[test]
    fn an_argument_that_could_steer_the_parse_is_refused() {
        for rejected in [
            "127.0.0.1\" --allow-external \"",
            "--port\"",
            "\"",
            "value\nnext",
            "value\ttab\u{7f}",
            "value\0",
            r"C:\state\logs\",
        ] {
            assert_eq!(
                command_line(Path::new(r"C:\payload\role.exe"), &[rejected.to_owned()])
                    .expect_err("only a representable argument may be assembled")
                    .kind(),
                io::ErrorKind::InvalidInput,
                "accepted {rejected:?}"
            );
        }
        // The program itself goes through the same check, so a payload root that somehow carried a
        // quote could not become an argument boundary either.
        assert_eq!(
            command_line(Path::new("C:\\payload\" \\role.exe"), &[])
                .expect_err("the program is an argument too")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn a_stdin_payload_is_one_bounded_line() {
        let payload = StdinPayload::single_line(b"{\"boot_id\":\"boot-0\"}\n").expect("one line");
        assert_eq!(payload.as_slice().last(), Some(&b'\n'));
        assert_eq!(payload.as_slice().len(), 21);
        assert_eq!(payload.clone().as_slice(), payload.as_slice());

        let mut at_bound = vec![b'x'; STDIN_PAYLOAD_MAX_BYTES - 1];
        at_bound.push(b'\n');
        assert_eq!(
            StdinPayload::single_line(&at_bound)
                .expect("exactly at the bound")
                .as_slice()
                .len(),
            STDIN_PAYLOAD_MAX_BYTES
        );
    }

    /// Each rejected shape is one the peer's single `readline` would mishandle: no terminator leaves it
    /// blocked, an interior newline leaves it a truncated request plus a remainder, and an over-bound
    /// payload is one it refuses outright.
    #[test]
    fn a_stdin_payload_that_the_peer_could_not_read_as_one_request_is_refused() {
        let over_bound = vec![b'x'; STDIN_PAYLOAD_MAX_BYTES + 1];
        for rejected in [
            &b""[..],
            b"\n",
            b"no terminator",
            b"first\nsecond\n",
            b"\nleading",
            &over_bound,
        ] {
            assert_eq!(
                StdinPayload::single_line(rejected)
                    .expect_err("only one bounded line is a payload")
                    .kind(),
                io::ErrorKind::InvalidData,
                "accepted {} bytes",
                rejected.len()
            );
        }
    }

    /// A payload's `Debug` says how much there is and never what it is, which is what keeps it safe to
    /// format in a panic or a refusal.
    #[test]
    fn a_stdin_payload_never_formats_its_contents() {
        let secret = "sentinel-caller-key-material";
        let payload =
            StdinPayload::single_line(format!("{secret}\n").as_bytes()).expect("one line");
        let formatted = format!("{payload:?}");
        assert!(!formatted.contains(secret), "{formatted}");
        assert_eq!(formatted, "StdinPayload { bytes: 29 }");

        // And a refusal names the bound, never the payload or its size.
        let refusal = StdinPayload::single_line(&vec![b'k'; STDIN_PAYLOAD_MAX_BYTES + 1])
            .expect_err("over the bound")
            .to_string();
        assert!(
            refusal.contains(&STDIN_PAYLOAD_MAX_BYTES.to_string()),
            "{refusal}"
        );
        assert!(
            !refusal.contains(&(STDIN_PAYLOAD_MAX_BYTES + 1).to_string()),
            "the refusal states the bound, not the payload: {refusal}"
        );
    }

    /// A spec never holds key material at all, because what it holds is a description.
    ///
    /// This is the property that keeps the owner hop from minting the Connector's keys: it resolves the
    /// same request the runner does, and the result names a search module rather than carrying a
    /// bootstrap.
    #[test]
    fn a_spec_describes_its_stdin_rather_than_carrying_it() {
        let spec = CatalogLaunchSpec {
            executable: PathBuf::from(r"C:\payload\role.exe"),
            command: r"C:\payload\role.exe".to_owned(),
            current_directory: PathBuf::from(r"C:\payload"),
            job_profile: JobLimitProfile::BootstrapTier,
            environment: Vec::new(),
            stdin: RoleStdin::ConnectorBootstrap {
                search_module: PathBuf::from(r"C:\payload\config-source\tools\sc_tavily_search.py"),
                endpoint: "http://127.0.0.1:47823/v1/connector".to_owned(),
            },
            log_directory: PathBuf::from(r"C:\state\logs\network_connector"),
        };
        let formatted = format!("{spec:?}");
        assert!(formatted.contains("sc_tavily_search.py"), "{formatted}");
        for secret_shape in ["boot-", "caller_", "response_", "key_b64"] {
            assert!(!formatted.contains(secret_shape), "{formatted}");
        }
        assert_eq!(spec.clone().stdin, spec.stdin);
    }
}

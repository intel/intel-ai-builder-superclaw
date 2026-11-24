//! The runtime's HTTP Basic credential, and which variables carry it to which role.
//!
//! Split out of `mod.rs` for the crate's line limit, and so the carrier rule has one home. The four
//! roles that call the runtime present the same pair under two client-specific spellings, and a name
//! written out in four resolvers is four places for one of them to drift.
//!
//! The environment is the only carrier, for the reason `OPENWORK_HOST_TOKEN` gives in
//! `resolve_supervisor`: a command line is readable by anything that can enumerate processes. The
//! password is bound as an opaque scalar, so it carries the redaction obligation in
//! `BROKER_OPAQUE_SCALARS`.

use super::*;

/// The fixed username. Not secret and not a scalar: it is the runtime's own default and the
/// supervisor's `DEFAULT_OPENCODE_USERNAME`, stated so every caller sends both halves explicitly -
/// openwork-server builds no header unless both are set.
pub(super) const RUNTIME_USERNAME: &str = "opencode";

/// Which spelling of the credential a role reads.
pub(super) enum RuntimeAuthReader {
    /// The runtime itself, and the router's SDK client.
    OpencodeServer,
    /// The supervisor and openwork-server.
    Openwork,
}

/// The username and password variables for one role, from the bound `runtime_password`.
pub(super) fn runtime_auth_environment(
    validated: &ValidatedStartRequest,
    reader: RuntimeAuthReader,
) -> io::Result<Vec<(String, String)>> {
    let password = scalar(validated, BrokerScalarPlaceholder::RuntimePassword)?;
    let (username_name, password_name) = match reader {
        RuntimeAuthReader::OpencodeServer => {
            ("OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD")
        }
        RuntimeAuthReader::Openwork => ("OPENWORK_OPENCODE_USERNAME", "OPENWORK_OPENCODE_PASSWORD"),
    };
    Ok(declared(&[
        (username_name, RUNTIME_USERNAME.to_owned()),
        (password_name, password.to_owned()),
    ]))
}

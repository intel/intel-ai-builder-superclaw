//! The isolation tier enum, kept free of Win32 account, token and credential surface.
//!
//! It lives apart from `identity_windows.rs` so the unelevated `native_isolation_launcher` bin can
//! name a tier without linking account management, `LogonUserW` or credential state.
//!
//! P3 moved the deterministic account-name derivation out of `identity_windows.rs` as promised, into
//! `identity_name` rather than into this file: that module also derives the credential and record
//! filenames and pins the golden vector its Python and PowerShell mirrors share, which is a larger
//! concern than the enum. `account_code` stays here because it is part of what a tier *is*, and
//! `identity_name` is its only caller.

/// The four product isolation tiers. The string form is the wire and CLI spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IsolationTier {
    Bootstrap,
    FileTool,
    NetworkConnector,
    Channel,
}

impl IsolationTier {
    pub const ALL: [Self; 4] = [
        Self::Bootstrap,
        Self::FileTool,
        Self::NetworkConnector,
        Self::Channel,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::FileTool => "file_tool",
            Self::NetworkConnector => "network_connector",
            Self::Channel => "channel",
        }
    }

    /// Exact-match parse of the closed CLI/wire spelling. Anything else is refused; there is no
    /// prefix, case or alias tolerance, because the tier selects an identity boundary.
    pub fn from_wire(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tier| tier.as_str() == value)
    }

    pub(crate) const fn account_code(self) -> char {
        match self {
            Self::Bootstrap => 'B',
            Self::FileTool => 'F',
            Self::NetworkConnector => 'C',
            // Never reused: an `SCBH…` account can only be a channel account.
            Self::Channel => 'H',
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_spelling_round_trips_and_rejects_near_misses() {
        for tier in IsolationTier::ALL {
            assert_eq!(IsolationTier::from_wire(tier.as_str()), Some(tier));
        }
        for value in ["", "Bootstrap", "bootstrap ", "file-tool", "connector"] {
            assert_eq!(IsolationTier::from_wire(value), None, "accepted {value:?}");
        }
    }

    #[test]
    fn account_codes_are_distinct_per_tier() {
        let codes: std::collections::BTreeSet<char> = IsolationTier::ALL
            .into_iter()
            .map(IsolationTier::account_code)
            .collect();
        assert_eq!(codes.len(), IsolationTier::ALL.len());
    }

    /// The channel tier is new and its letter is new: `H`, never one of B/F/C and never reused, so an
    /// `SCBH…` account can only be a channel account.
    #[test]
    fn channel_is_a_fourth_tier_with_its_own_letter() {
        assert_eq!(IsolationTier::ALL.len(), 4);
        assert_eq!(
            IsolationTier::from_wire("channel"),
            Some(IsolationTier::Channel)
        );
        assert_eq!(IsolationTier::Channel.as_str(), "channel");
        assert_eq!(IsolationTier::Channel.account_code(), 'H');
    }
}

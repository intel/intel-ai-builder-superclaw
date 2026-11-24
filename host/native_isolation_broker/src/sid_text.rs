//! Shape validation for a SID in its string (SDDL) form.
//!
//! The unelevated launcher needs to refuse a malformed `--owner-sid` argument before it does
//! anything with it, but it must not link the account-lookup surface to do so: resolving a SID to a
//! principal is the elevated broker's job, and `win32.rs` (which can do that) also carries the
//! named-pipe server and process-witness code that has no business inside the launcher.
//!
//! This is therefore deliberately a syntax check only. It proves the argument is a SID literal, not
//! that the SID exists or that the caller is entitled to it. Authorization stays with the broker.

use std::io;

/// Maximum textual SID length: `S-1-` plus a 48-bit authority plus 15 32-bit sub-authorities.
const MAX_SID_TEXT_LEN: usize = 184;
const MAX_SUB_AUTHORITIES: usize = 15;

pub fn validate_sid_text(value: &str) -> io::Result<()> {
    if well_formed(value) {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "owner SID is not a well-formed textual SID",
        ))
    }
}

fn well_formed(value: &str) -> bool {
    if value.len() > MAX_SID_TEXT_LEN {
        return false;
    }
    let Some(rest) = value.strip_prefix("S-1-") else {
        return false;
    };
    let mut parts = rest.split('-');
    // The identifier authority, then at least one relative identifier.
    let Some(authority) = parts.next() else {
        return false;
    };
    if !is_decimal_component(authority) {
        return false;
    }
    let mut sub_authorities = 0;
    for part in parts {
        if !is_decimal_component(part) {
            return false;
        }
        sub_authorities += 1;
        if sub_authorities > MAX_SUB_AUTHORITIES {
            return false;
        }
    }
    sub_authorities >= 1
}

fn is_decimal_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_account_sids_are_accepted() {
        for value in [
            "S-1-5-21-100-200-300-1001",
            "S-1-5-18",
            "S-1-5-32-544",
            "S-1-5-21-0-0-0-500",
        ] {
            assert!(validate_sid_text(value).is_ok(), "rejected {value}");
        }
    }

    #[test]
    fn malformed_and_injected_values_are_refused() {
        for value in [
            "",
            "S-1-5",
            "s-1-5-21-1-2-3-1001",
            "S-2-5-21-1",
            "S-1-5-21-1-2-3-1001-",
            "S-1-5-21-1-2-3-x",
            "S-1-5-21-01-2-3-1001",
            "S-1-5-21-1-2-3-1001 --extra",
            "S-1-5-21-1-2-3-1001\0",
            &format!("S-1-5-21{}", "-1".repeat(20)),
            &format!("S-1-5-21-{}", "9".repeat(200)),
        ] {
            assert!(
                validate_sid_text(value).is_err(),
                "accepted {value:?}, which is not a SID"
            );
        }
    }
}

//! The explicit environment block handed to a same-account role launch.
//!
//! `CreateProcessW` with `lpEnvironment = NULL` copies the *caller's* whole environment into the
//! child. That is not acceptable for a tier launch: the owner-side process and the tier runner both
//! carry variables the role must never observe, and their contents vary per machine, so the launch
//! would not be reproducible either. Every same-account launch therefore builds a block from a fixed
//! allowlist plus the catalog's declared overlay, and passes it with `CREATE_UNICODE_ENVIRONMENT`.
//!
//! The allowlisted values are read from the launching process, which makes the *scope* of each name
//! the thing that decides whether it may cross a hop. Within one account it always may, so a
//! same-account launch uses `resolve_role_environment`. Across the first hop it may not: the owner's
//! `USERPROFILE`, `APPDATA`, `TEMP`, `TMP` and `USERNAME` describe the owner, and handing them to a
//! process running as a tier account would both misdescribe it and point it at directories it has no
//! access to. `resolve_cross_account_environment` drops exactly those names, which is why a launch
//! into a tier account gets a strictly machine-scoped block.
//!
//! `CreateProcessWithLogonW` does not fill the gap on its own. Under the `TIER_LOGON_FLAGS = 0` that
//! `launcher::logon` uses, no profile hive is loaded for the tier account, so Windows supplies no
//! per-account replacement for the names that were dropped, and none appears in the child at all. A
//! catalog entry that needs a per-tier writable location must therefore declare it explicitly; the
//! declared overlay is applied after the filter, so a declaration is still honoured.
//!
//! This is never `CreateEnvironmentBlock`. Nothing here reads an account's registry profile, so a
//! variable that exists only in a profile is absent unless the catalog declares it.

use std::io;

/// Variables a Windows process needs to be able to run at all, plus the per-account locations a
/// role legitimately writes to. Anything outside this list must be declared by the catalog entry, so
/// adding a variable to a role's environment is a reviewable catalog change rather than an accident
/// of whatever shell started the launcher.
pub const BASE_ENVIRONMENT: &[&str] = &[
    "ALLUSERSPROFILE",
    "APPDATA",
    "COMMONPROGRAMFILES",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PUBLIC",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
];

/// The subset of `BASE_ENVIRONMENT` whose value describes the account the launching process runs as
/// rather than the machine it runs on.
///
/// These are the names that must not cross an account boundary. Two separate reasons, both fatal on
/// their own: the value would be wrong (a tier process announcing the owner's `USERNAME`), and it
/// would point at a directory the tier account cannot open (`TEMP` under the owner's profile), so a
/// role that tried to use it would fail in a way that looks like a bug rather than like a missing
/// declaration.
pub const PER_ACCOUNT_ENVIRONMENT: &[&str] = &[
    "APPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
];

/// Builds the variable set for a process launched into a *different* account: the machine-scoped part
/// of `source`, overlaid with the catalog's declared variables.
///
/// The filter is applied to the source and not to the result, so a declared variable still wins even
/// when it names something in `PER_ACCOUNT_ENVIRONMENT`. That is the intended escape hatch: the
/// launch never guesses a per-account location, but a catalog entry may state one.
pub fn resolve_cross_account_environment(
    source: impl Iterator<Item = (String, String)>,
    declared: &[(String, String)],
) -> io::Result<Vec<(String, String)>> {
    resolve_role_environment(
        source.filter(|(name, _)| {
            !PER_ACCOUNT_ENVIRONMENT.contains(&name.to_ascii_uppercase().as_str())
        }),
        declared,
    )
}

/// Builds the role's full variable set: the allowlisted subset of `source` overlaid with the
/// catalog's declared variables. Names are canonicalized to upper case because Windows environment
/// lookups are case-insensitive, and a block containing both `Path` and `PATH` is ambiguous.
pub fn resolve_role_environment(
    source: impl Iterator<Item = (String, String)>,
    declared: &[(String, String)],
) -> io::Result<Vec<(String, String)>> {
    let mut resolved: Vec<(String, String)> = Vec::new();
    for (name, value) in source {
        let name = name.to_ascii_uppercase();
        if BASE_ENVIRONMENT.contains(&name.as_str()) && !resolved.iter().any(|(n, _)| *n == name) {
            resolved.push((name, value));
        }
    }
    for (name, value) in declared {
        let name = name.to_ascii_uppercase();
        validate_name(&name)?;
        match resolved.iter_mut().find(|(existing, _)| *existing == name) {
            Some(entry) => entry.1 = value.clone(),
            None => resolved.push((name, value.clone())),
        }
    }
    resolved.sort_by(|(left, _), (right, _)| left.cmp(right));
    Ok(resolved)
}

/// Reads the current process's environment as the allowlist source.
pub fn current_process_environment() -> io::Result<Vec<(String, String)>> {
    std::env::vars_os()
        .map(|(name, value)| {
            let name = name.into_string().map_err(|_| non_unicode())?;
            let value = value.into_string().map_err(|_| non_unicode())?;
            Ok((name, value))
        })
        .collect()
}

/// Encodes the block `CreateProcessW` expects: NUL-terminated `NAME=VALUE` strings followed by a
/// final NUL. The result is never empty, so it can never be confused with "inherit everything".
pub fn encode_environment_block(entries: &[(String, String)]) -> io::Result<Vec<u16>> {
    if entries.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a role environment must contain at least the base Windows variables",
        ));
    }
    let mut block = Vec::new();
    for (name, value) in entries {
        validate_name(name)?;
        if value.contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("environment value for {name} contains a NUL"),
            ));
        }
        block.extend(name.encode_utf16());
        block.push(u16::from(b'='));
        block.extend(value.encode_utf16());
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

pub fn environment_names(entries: &[(String, String)]) -> Vec<String> {
    entries.iter().map(|(name, _)| name.clone()).collect()
}

fn validate_name(name: &str) -> io::Result<()> {
    if name.is_empty() || name.contains('=') || name.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{name:?} is not a usable environment variable name"),
        ));
    }
    Ok(())
}

fn non_unicode() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "the launching environment contains a non-Unicode variable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn undeclared_variables_never_reach_the_role() {
        let resolved = resolve_role_environment(
            source(&[
                ("SystemRoot", r"C:\Windows"),
                ("SUPERCLAW_OWNER_SECRET", "leaked"),
                ("AWS_ACCESS_KEY_ID", "leaked"),
            ])
            .into_iter(),
            &[],
        )
        .expect("resolution should succeed");

        assert_eq!(
            environment_names(&resolved),
            vec!["SYSTEMROOT".to_owned()],
            "only allowlisted names survive"
        );
    }

    #[test]
    fn declared_overlay_wins_and_is_sorted_and_canonicalized() {
        let resolved = resolve_role_environment(
            source(&[("Path", r"C:\Windows"), ("TEMP", r"C:\Temp")]).into_iter(),
            &source(&[("path", "declared"), ("Superclaw_Role", "1")]),
        )
        .expect("resolution should succeed");

        assert_eq!(
            resolved,
            source(&[
                ("PATH", "declared"),
                ("SUPERCLAW_ROLE", "1"),
                ("TEMP", r"C:\Temp"),
            ])
        );
    }

    #[test]
    fn block_is_nul_terminated_and_never_empty() {
        let block = encode_environment_block(&source(&[("A", "1"), ("B", "2")]))
            .expect("block should encode");
        let expected: Vec<u16> = "A=1\0B=2\0\0".encode_utf16().collect();
        assert_eq!(block, expected);
        assert_eq!(
            encode_environment_block(&[])
                .expect_err("an empty block would be indistinguishable from inheriting everything")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn malformed_names_and_values_are_refused() {
        assert!(encode_environment_block(&source(&[("A=B", "1")])).is_err());
        assert!(encode_environment_block(&source(&[("", "1")])).is_err());
        assert!(encode_environment_block(&source(&[("A", "1\0 2")])).is_err());
    }

    #[test]
    fn a_cross_account_launch_carries_no_variable_that_describes_the_launching_account() {
        // Every per-account name is also an allowlisted one, or the filter would be describing names
        // that could never have been there in the first place.
        assert!(
            PER_ACCOUNT_ENVIRONMENT
                .iter()
                .all(|name| BASE_ENVIRONMENT.contains(name))
        );

        let owner = source(&[
            ("SystemRoot", r"C:\Windows"),
            ("Path", r"C:\Windows\System32"),
            ("USERNAME", "owner"),
            ("USERPROFILE", r"C:\Users\owner"),
            ("TEMP", r"C:\Users\owner\AppData\Local\Temp"),
            ("APPDATA", r"C:\Users\owner\AppData\Roaming"),
            ("LOCALAPPDATA", r"C:\Users\owner\AppData\Local"),
            ("HOMEDRIVE", "C:"),
            ("HOMEPATH", r"\Users\owner"),
            ("USERDOMAIN", "OWNERPC"),
            ("TMP", r"C:\Users\owner\AppData\Local\Temp"),
        ]);

        let same_account = resolve_role_environment(owner.clone().into_iter(), &[]).unwrap();
        let cross_account = resolve_cross_account_environment(owner.into_iter(), &[]).unwrap();
        assert_eq!(
            environment_names(&cross_account),
            vec!["PATH".to_owned(), "SYSTEMROOT".to_owned()]
        );
        assert!(
            environment_names(&same_account).len() > environment_names(&cross_account).len(),
            "the filter has to remove something, or this test proves nothing"
        );
        for (name, value) in &cross_account {
            assert!(
                !value.contains("owner"),
                "{name} still describes the launching account: {value}"
            );
        }
    }

    #[test]
    fn a_cross_account_launch_still_honours_a_declared_per_account_location() {
        // The filter removes what the owner *happens* to have; it does not veto what the catalog
        // states, because a per-tier writable location has to be expressible somehow.
        let resolved = resolve_cross_account_environment(
            source(&[("TEMP", r"C:\Users\owner\AppData\Local\Temp")]).into_iter(),
            &source(&[("TEMP", r"C:\ProgramData\SuperClaw\isolation\tier-temp")]),
        )
        .unwrap();
        assert_eq!(
            resolved,
            source(&[("TEMP", r"C:\ProgramData\SuperClaw\isolation\tier-temp")])
        );
    }

    /// The block the first hop really passes: this process's own environment, filtered, encoded, and
    /// decoded back out of its UTF-16 form.
    ///
    /// The cross-account tests above stop at the resolved pairs, one encoding step short of what
    /// `CreateProcessWithLogonW` reads, and they use a fixture rather than the live environment. This one
    /// closes both gaps, so an encoder that ever added a name of its own, or a filter that stopped being
    /// applied to the real source, fails here rather than in a tier process holding the owner's `TEMP`.
    #[test]
    fn the_live_cross_account_block_carries_no_name_that_describes_this_account() {
        let resolved = resolve_cross_account_environment(
            current_process_environment()
                .expect("environment should be readable")
                .into_iter(),
            &[],
        )
        .expect("resolution should succeed");
        let block = encode_environment_block(&resolved).expect("the block should encode");
        assert!(
            block.ends_with(&[0, 0]),
            "a block without its second terminator is read past its end"
        );
        let decoded = String::from_utf16(&block[..block.len() - 1]).expect("the block is UTF-16");
        let names: Vec<&str> = decoded
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .map(|entry| entry.split('=').next().expect("every entry has a name"))
            .collect();
        assert!(names.contains(&"SYSTEMROOT"), "{names:?}");
        for excluded in PER_ACCOUNT_ENVIRONMENT {
            assert!(
                !names.contains(excluded),
                "{excluded} describes this account and must not cross the hop: {names:?}"
            );
        }
    }

    #[test]
    fn the_live_process_environment_supplies_the_base_variables() {
        let current = current_process_environment().expect("environment should be readable");
        let resolved =
            resolve_role_environment(current.into_iter(), &[]).expect("resolution should succeed");
        let names = environment_names(&resolved);
        assert!(
            names.contains(&"SYSTEMROOT".to_owned()),
            "SYSTEMROOT is required for any Windows process: {names:?}"
        );
        assert!(names.iter().all(|name| BASE_ENVIRONMENT.contains(&&**name)));
    }
}

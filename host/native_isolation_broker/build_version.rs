//! The version `build.rs` stamps into the version resource. Kept out of `build.rs` so that
//! `tests/build_version.rs` can include the same file and exercise it.

/// `SUPERCLAW_BUILD_VERSION` when the build sets it, so the binaries carry the real product version
/// (x.y.z.<Mdd>) the installer scripts stamp everywhere else; otherwise the crate version with a zero
/// fourth part. Returns the four numeric parts of `FILEVERSION` and the string form of the same.
///
/// A set but malformed value is an error rather than a silent fallback: a release build that shipped
/// the crate version instead of the product version would look correct until someone read it.
pub fn resolve(build_version: Option<&str>, crate_version: [u16; 3]) -> Result<[u16; 4], String> {
    let Some(value) = build_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        let [major, minor, patch] = crate_version;
        return Ok([major, minor, patch, 0]);
    };
    let malformed = || {
        format!(
            "SUPERCLAW_BUILD_VERSION must be a four-part numeric version x.y.z.w with each part 0-65535, got '{value}'"
        )
    };
    let parts = value
        .split('.')
        .map(|part| {
            // `u16::from_str` accepts a leading `+`, which is not a version.
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(malformed());
            }
            part.parse::<u16>().map_err(|_| malformed())
        })
        .collect::<Result<Vec<u16>, String>>()?;
    parts.try_into().map_err(|_| malformed())
}

/// The dotted form of a resolved version, as the string fields of the version resource carry it.
pub fn display(version: [u16; 4]) -> String {
    let [major, minor, patch, build] = version;
    format!("{major}.{minor}.{patch}.{build}")
}

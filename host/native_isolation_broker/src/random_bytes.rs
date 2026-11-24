//! Cryptographically secure random bytes, via `BCryptGenRandom`.
//!
//! Split out from `random.rs` so the unelevated launcher can draw a pipe id and a per-launch
//! authentication key without also linking account-password generation, which it has no business
//! carrying.

use std::io;
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};

/// Fills `buf` with cryptographically secure random bytes using the OS's preferred RNG.
pub fn fill_random(buf: &mut [u8]) -> io::Result<()> {
    // SAFETY: `buf` is a valid, properly sized slice; `BCryptGenRandom` writes at most
    // `buf.len()` bytes into it and returns a status code we check below.
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(io::Error::other(format!(
            "BCryptGenRandom failed with NTSTATUS 0x{status:08X}"
        )));
    }
    Ok(())
}

/// `bytes` random bytes as lowercase hex, which is the form both a pipe id and an authentication key
/// argument take. Hex rather than base64 because a pipe id has to survive being a file-system name and
/// an argument has to survive being copied by hand into a failure report.
pub fn random_hex(bytes: usize) -> io::Result<String> {
    let mut buffer = vec![0u8; bytes];
    fill_random(&mut buffer)?;
    Ok(hex::encode(buffer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_hex_has_the_requested_length_and_does_not_repeat() {
        let first = random_hex(16).expect("the system RNG should be available");
        let second = random_hex(16).expect("the system RNG should be available");
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(
            first, second,
            "two draws colliding would mean the RNG is not being consulted"
        );
    }
}

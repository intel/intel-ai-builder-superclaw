//! Containers that wipe their contents before releasing them.
//!
//! Exactly one kind of value in this crate needs this: the plaintext of a tier account password. On
//! the way from a credential file to `CreateProcessWithLogonW` it exists in three representations -
//! the bytes DPAPI hands back, the UTF-8 those bytes are validated as, and the NUL-terminated UTF-16
//! buffer Win32 requires - and execution plan P4 requires every one of them to be zeroed as soon as
//! the call returns. Expressing that as a type rather than as a rule callers must remember is what
//! makes it hold on the error paths too, which is where a manual wipe is always the one that is
//! forgotten.
//!
//! Two properties make the wipe real rather than decorative:
//!
//! - the store goes through `write_volatile` and is followed by a `compiler_fence`, so the compiler
//!   may not elide writes to memory it can see is about to be freed;
//! - every buffer is allocated once at its exact final size and never grown, because a `Vec` that
//!   reallocates hands the old block - still holding the plaintext - back to the allocator untouched,
//!   and the wipe would then clear a copy that no longer matters.
//!
//! # What this does not claim
//!
//! Not that the plaintext is unobservable. A page can be paged out, a crash dump can be taken before
//! the wipe runs, and the kernel necessarily copies the password out of this buffer during the logon
//! itself. Wiping bounds the window inside this process's own heap and nothing more; 启动权威 §4.2
//! places the confidentiality boundary on the credential file's DACL, not on this module, and the
//! design deliberately does not promise the stronger property.

use std::io;
use std::sync::atomic::{Ordering, compiler_fence};

/// A byte buffer that is zeroed when it is dropped.
pub struct ZeroizedBytes(Vec<u8>);

impl ZeroizedBytes {
    /// Copies `source` into a buffer allocated at exactly its length.
    ///
    /// Copying rather than adopting a caller's `Vec` is deliberate: an adopted vector may carry spare
    /// capacity, or may already have reallocated once, and this container can only promise to wipe
    /// storage whose size it chose itself.
    pub fn copy_from(source: &[u8]) -> Self {
        let mut bytes = Vec::with_capacity(source.len());
        bytes.extend_from_slice(source);
        Self(bytes)
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for ZeroizedBytes {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

/// A NUL-terminated UTF-16 buffer that is zeroed when it is dropped, for a Win32 `PCWSTR` password.
pub struct ZeroizedWide(Vec<u16>);

impl ZeroizedWide {
    /// Encodes UTF-8 bytes as NUL-terminated UTF-16 in a single exactly-sized allocation.
    ///
    /// The input is borrowed and the output is counted before it is built, so the plaintext gains no
    /// third copy on the way through: there is no intermediate `String` and no reallocation. A
    /// credential that is not valid UTF-8 is refused here rather than lossily converted, because a
    /// password Windows would not accept is a provisioning failure and not something to guess at.
    pub fn from_utf8(bytes: &[u8]) -> io::Result<Self> {
        let text = std::str::from_utf8(bytes).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "the stored tier credential is not valid UTF-8",
            )
        })?;
        if text.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the stored tier credential is empty",
            ));
        }
        let mut units = Vec::with_capacity(text.encode_utf16().count() + 1);
        units.extend(text.encode_utf16());
        units.push(0);
        Ok(Self(units))
    }

    /// The buffer as a `PCWSTR`. Valid only while `self` is alive, which is the whole point.
    pub fn as_ptr(&self) -> *const u16 {
        self.0.as_ptr()
    }
}

impl Drop for ZeroizedWide {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

/// Overwrites every element with zero in a way the optimizer may not remove.
///
/// `write_volatile` per element rather than `slice::fill`: the latter is a plain store the compiler is
/// entitled to drop entirely once it can prove nothing reads the values again, which is exactly the
/// situation here. The fence keeps the stores from being sunk past the deallocation that follows.
pub fn wipe<T: Copy + Default>(values: &mut [T]) {
    for slot in values.iter_mut() {
        // SAFETY: `slot` is a valid, aligned, exclusively borrowed `T`.
        unsafe {
            std::ptr::write_volatile(slot, T::default());
        }
    }
    compiler_fence(Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wipe_clears_a_live_byte_buffer() {
        let mut buffer = b"tier-password-sentinel".to_vec();
        wipe(&mut buffer);
        assert!(
            buffer.iter().all(|byte| *byte == 0),
            "the credential buffer still held its plaintext"
        );
    }

    #[test]
    fn wipe_clears_a_live_wide_buffer() {
        let mut buffer: Vec<u16> = "tier-password-sentinel"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        wipe(&mut buffer);
        assert!(
            buffer.iter().all(|unit| *unit == 0),
            "the password buffer still held its plaintext"
        );
    }

    #[test]
    fn the_wide_buffer_is_allocated_once_at_its_exact_size() {
        // A reallocation would leave the plaintext in a block this container never sees again, so the
        // exact-capacity property is part of the wipe rather than a micro-optimization.
        let buffer = ZeroizedWide::from_utf8("pässwörd-ünïcode".as_bytes()).expect("valid UTF-8");
        assert_eq!(buffer.0.len(), buffer.0.capacity());
        assert_eq!(
            buffer.0.len(),
            "pässwörd-ünïcode".encode_utf16().count() + 1
        );

        let bytes = ZeroizedBytes::copy_from(&[7u8; 33]);
        assert_eq!(bytes.0.len(), bytes.0.capacity());
    }

    /// Neither container implements `Debug`, deliberately: a derived one would print the plaintext into
    /// a panic message or a log line, which is exactly the leak the rest of this module prevents. That
    /// is why this test matches on the result instead of reaching for `expect_err`, and why a future
    /// change that adds `Debug` to make an assertion easier would be trading the property away for the
    /// convenience of the test that checks it.
    #[test]
    fn a_credential_that_is_not_a_usable_password_is_refused_rather_than_converted() {
        for rejected in [&[0xffu8, 0xfe][..], b""] {
            match ZeroizedWide::from_utf8(rejected) {
                Ok(_) => panic!("only a non-empty UTF-8 credential is a password"),
                Err(error) => assert_eq!(error.kind(), io::ErrorKind::InvalidData),
            }
        }
    }
}

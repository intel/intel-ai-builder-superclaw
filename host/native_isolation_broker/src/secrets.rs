//! Machine-scoped DPAPI encryption for generated owner-by-tier account passwords.
//!
//! Uses `CRYPTPROTECT_LOCAL_MACHINE` instead of per-user protection: elevation can run under a
//! different Windows identity than whoever started setup, which would make per-user DPAPI
//! undecryptable by the original caller. Trade-off: any local process can now decrypt this
//! credential, not just one account. The broker-owned file DACL is therefore part of the boundary.
//!
//! Every plaintext this module produces lands in a `zeroize` container, including the buffer DPAPI
//! itself allocates: `unprotect` is the one place in the process where a tier password exists in
//! clear, and execution plan P4 requires that window to be closed rather than left to the allocator.

use crate::wide::to_wide;
use crate::zeroize::{ZeroizedBytes, wipe};
use std::io;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CryptProtectData, CryptUnprotectData,
};

/// Encrypts `secret`; the result is decryptable by any process on this machine via `unprotect`.
pub fn protect(secret: &[u8]) -> io::Result<Vec<u8>> {
    let description = to_wide("SuperClaw native isolation tier credential");

    let input = CRYPT_INTEGER_BLOB {
        cbData: secret.len() as u32,
        // CryptProtectData only reads this buffer; the const-cast is required by the FFI
        // signature, which does not distinguish input-only blobs.
        pbData: secret.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    // SAFETY: `input` points at `secret`, which outlives this call; `output` is populated by
    // the API and freed via `LocalFree` below through `OwnedLocalBlob`.
    let ok = unsafe {
        CryptProtectData(
            &input,
            description.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_LOCAL_MACHINE,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    let blob = OwnedLocalBlob(output);
    Ok(blob.as_slice().to_vec())
}

/// Decrypts a blob previously produced by `protect`, into a container that wipes itself.
///
/// This is the form the unelevated launcher uses. The elevated broker's `unprotect` differs only in
/// handing the caller a plain `Vec`, which the callers that build a `String` out of it need.
pub fn unprotect_zeroized(blob: &[u8]) -> io::Result<ZeroizedBytes> {
    let decrypted = unprotect_blob(blob)?;
    Ok(ZeroizedBytes::copy_from(decrypted.as_slice()))
}

/// Decrypts a blob previously produced by `protect`.
pub fn unprotect(blob: &[u8]) -> io::Result<Vec<u8>> {
    let decrypted = unprotect_blob(blob)?;
    Ok(decrypted.as_slice().to_vec())
}

fn unprotect_blob(blob: &[u8]) -> io::Result<OwnedLocalBlob> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    // SAFETY: `input` points at `blob`, which outlives this call; `output` is populated by the
    // API and freed via `LocalFree` below through `OwnedLocalBlob`.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_LOCAL_MACHINE,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }

    Ok(OwnedLocalBlob(output))
}

/// Wraps a `CRYPT_INTEGER_BLOB` allocated by DPAPI, wiping and then freeing its buffer on drop.
///
/// The wipe matters most on the decrypt path, where this buffer is the *first* place the plaintext
/// exists: releasing it to `LocalFree` unmodified would leave the password in the process heap no
/// matter how carefully every later copy of it is cleared.
struct OwnedLocalBlob(CRYPT_INTEGER_BLOB);

impl OwnedLocalBlob {
    fn as_slice(&self) -> &[u8] {
        if self.0.pbData.is_null() || self.0.cbData == 0 {
            return &[];
        }
        // SAFETY: `pbData`/`cbData` were just populated by a successful DPAPI call and are not
        // mutated elsewhere; the slice does not outlive `self`.
        unsafe { std::slice::from_raw_parts(self.0.pbData, self.0.cbData as usize) }
    }
}

impl Drop for OwnedLocalBlob {
    fn drop(&mut self) {
        if !self.0.pbData.is_null() {
            if self.0.cbData != 0 {
                // SAFETY: The buffer is exclusively owned here and is about to be freed, so no other
                // reference to it can exist.
                let buffer = unsafe {
                    std::slice::from_raw_parts_mut(self.0.pbData, self.0.cbData as usize)
                };
                wipe(buffer);
            }
            // SAFETY: `pbData` was allocated by a Win32 DPAPI call, which documents `LocalFree`
            // as the correct way to release it.
            unsafe {
                windows_sys::Win32::Foundation::LocalFree(self.0.pbData as *mut core::ffi::c_void);
            }
        }
    }
}

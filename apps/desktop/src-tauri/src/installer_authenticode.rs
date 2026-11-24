//! Windows Authenticode verification via WinVerifyTrust + Crypt32 (no PowerShell).

use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Security::Cryptography::{
    CertCloseStore, CertFindCertificateInStore, CertFreeCertificateContext, CertNameToStrW,
    CryptMsgClose, CryptMsgGetParam, CryptQueryObject, CERT_CONTEXT, CERT_FIND_SUBJECT_CERT,
    CERT_INFO, CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED, CERT_QUERY_FORMAT_FLAG_BINARY,
    CERT_QUERY_OBJECT_FILE, CERT_X500_NAME_STR, CMSG_SIGNER_CERT_INFO_PARAM, HCERTSTORE,
    PKCS_7_ASN_ENCODING, X509_ASN_ENCODING,
};
use windows_sys::Win32::Security::WinTrust::{
    WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
    WINTRUST_FILE_INFO, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
    WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};

fn path_to_wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn win_verify_trust(path_w: &[u16]) -> Result<(), String> {
    let mut file_info = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: path_w.as_ptr(),
        hFile: std::ptr::null_mut(),
        pgKnownSubject: std::ptr::null_mut(),
    };

    let mut trust_data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        pPolicyCallbackData: std::ptr::null_mut(),
        pSIPClientData: std::ptr::null_mut(),
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 {
            pFile: &mut file_info,
        },
        dwStateAction: WTD_STATEACTION_VERIFY,
        hWVTStateData: std::ptr::null_mut(),
        pwszURLReference: std::ptr::null_mut(),
        dwProvFlags: 0,
        dwUIContext: 0,
        pSignatureSettings: std::ptr::null_mut(),
    };

    let mut action_id = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let verify_result = unsafe {
        WinVerifyTrust(
            std::ptr::null_mut() as HWND,
            &mut action_id,
            &mut trust_data as *mut WINTRUST_DATA as *mut c_void,
        )
    };

    trust_data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(
            std::ptr::null_mut() as HWND,
            &mut action_id,
            &mut trust_data as *mut WINTRUST_DATA as *mut c_void,
        );
    }

    if verify_result == 0 {
        Ok(())
    } else {
        Err(format!(
            "The installer signature is not valid (WinVerifyTrust error {verify_result:#x})."
        ))
    }
}

fn signer_subject_dn(path_w: &[u16]) -> Result<String, String> {
    let mut store: HCERTSTORE = std::ptr::null_mut();
    let mut msg: *mut c_void = std::ptr::null_mut();

    let ok = unsafe {
        CryptQueryObject(
            CERT_QUERY_OBJECT_FILE,
            path_w.as_ptr() as *const c_void,
            CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED_EMBED,
            CERT_QUERY_FORMAT_FLAG_BINARY,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut store,
            &mut msg,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err("Could not read the installer signing certificate.".to_string());
    }

    let result = signer_subject_from_msg(store, msg);

    unsafe {
        if !msg.is_null() {
            CryptMsgClose(msg);
        }
        if !store.is_null() {
            CertCloseStore(store, 0);
        }
    }

    result
}

fn signer_subject_from_msg(store: HCERTSTORE, msg: *mut c_void) -> Result<String, String> {
    let mut cb_data: u32 = 0;
    let ok = unsafe {
        CryptMsgGetParam(
            msg,
            CMSG_SIGNER_CERT_INFO_PARAM,
            0,
            std::ptr::null_mut(),
            &mut cb_data,
        )
    };
    if ok == 0 || cb_data == 0 {
        return Err("Installer signer certificate info is missing.".to_string());
    }

    let mut cert_info_bytes = vec![0u8; cb_data as usize];
    let ok = unsafe {
        CryptMsgGetParam(
            msg,
            CMSG_SIGNER_CERT_INFO_PARAM,
            0,
            cert_info_bytes.as_mut_ptr() as *mut c_void,
            &mut cb_data,
        )
    };
    if ok == 0 {
        return Err("Failed to read installer signer certificate info.".to_string());
    }

    let cert_info = cert_info_bytes.as_ptr() as *const CERT_INFO;
    let encoding = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING;
    let cert_ctx = unsafe {
        CertFindCertificateInStore(
            store,
            encoding,
            0,
            CERT_FIND_SUBJECT_CERT,
            cert_info as *const c_void,
            std::ptr::null(),
        )
    };
    if cert_ctx.is_null() {
        return Err("Installer signer certificate was not found in the signature.".to_string());
    }

    let subject = cert_subject_dn(cert_ctx);
    unsafe {
        CertFreeCertificateContext(cert_ctx);
    }
    subject
}

fn cert_subject_dn(cert_ctx: *const CERT_CONTEXT) -> Result<String, String> {
    if cert_ctx.is_null() {
        return Err("Missing certificate context.".to_string());
    }
    let cert_info = unsafe { (*cert_ctx).pCertInfo };
    if cert_info.is_null() {
        return Err("Missing certificate info.".to_string());
    }

    let mut buf_len = 256u32;
    let mut buffer = vec![0u16; buf_len as usize];
    let written = unsafe {
        CertNameToStrW(
            X509_ASN_ENCODING,
            &(*cert_info).Subject,
            CERT_X500_NAME_STR,
            buffer.as_mut_ptr(),
            buf_len,
        )
    };
    if written as usize >= buffer.len() {
        buf_len = written + 1;
        buffer = vec![0u16; buf_len as usize];
        let written = unsafe {
            CertNameToStrW(
                X509_ASN_ENCODING,
                &(*cert_info).Subject,
                CERT_X500_NAME_STR,
                buffer.as_mut_ptr(),
                buf_len,
            )
        };
        if written == 0 {
            return Err("Failed to format signer certificate subject.".to_string());
        }
    } else if written == 0 {
        return Err("Failed to format signer certificate subject.".to_string());
    }

    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    Ok(String::from_utf16_lossy(&buffer[..end]))
}

/// Verify Authenticode trust and that the signer DN contains `expected_subject_marker`
/// (e.g. `O=Intel Corporation`).
pub fn verify_signed_installer(path: &Path, expected_subject_marker: &str) -> Result<(), String> {
    let path_w = path_to_wide(path);
    win_verify_trust(&path_w)?;
    let subject = signer_subject_dn(&path_w)?;
    if !subject.contains(expected_subject_marker) {
        return Err(format!(
            "Installer is signed by an unexpected publisher ({subject})."
        ));
    }
    Ok(())
}

//! The filtering engine, opened to read: `fwpuclnt.dll` behind the `WfpReader` seam.
//!
//! This is everything the unelevated launcher compiles of the engine, and it holds no write call: no
//! `FwpmTransaction*`, no `Fwpm*Add0` and no `Fwpm*Delete*`. Writing lives in `engine_win32`, which only
//! the elevated broker compiles, and a test over this module tree and over the launcher binary's imports
//! keeps it that way.
//!
//! A filter that does not read back as one the writer produces - an unknown field, a hard permit, a
//! provider - is reported with no conditions, which never equals a desired filter, so a comparison
//! treats it as different rather than trusting it.

use super::contract::{Layer, wfp_rules};
use super::filters::{Condition, DesiredFilter, FilterAction};
use super::key::to_guid;
use super::{InstalledFilter, InstalledSublayer, WfpReader};
use crate::sid_win32::sid_to_string;
use std::ffi::c_void;
use std::io;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{FWP_E_FILTER_NOT_FOUND, FWP_E_SUBLAYER_NOT_FOUND, HANDLE};
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
use windows_sys::Win32::Security::{ACCESS_ALLOWED_ACE, ACL, GetAce, GetSecurityDescriptorDacl};
use windows_sys::core::GUID;

const RPC_C_AUTHN_WINNT: u32 = 10;
/// The one right an `ALE_USER_ID` descriptor grants: the condition matches a token the access check
/// gives it to.
const FWP_ACTRL_MATCH_FILTER: u32 = 0x0000_0001;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
/// How long a transaction waits for another writer's to finish before failing.
pub(in crate::wfp) const TRANSACTION_WAIT_MS: u32 = 5_000;

/// A session on the engine. The reads need no transaction; the writer shares this handle for its own.
pub(crate) struct Win32WfpReader {
    pub(in crate::wfp) handle: HANDLE,
}

impl Win32WfpReader {
    /// Opens a non-dynamic session with the caller's own token.
    pub(crate) fn open() -> io::Result<Self> {
        // SAFETY: FWPM_SESSION0 is a plain C struct; all-zero is a valid, empty value for every field.
        let mut session: FWPM_SESSION0 = unsafe { std::mem::zeroed() };
        session.txnWaitTimeoutInMSec = TRANSACTION_WAIT_MS;
        let mut handle: HANDLE = null_mut();
        // SAFETY: the session outlives the call and the handle is written on success only.
        check(unsafe {
            FwpmEngineOpen0(null(), RPC_C_AUTHN_WINNT, null(), &session, &mut handle)
        })?;
        Ok(Self { handle })
    }
}

impl Drop for Win32WfpReader {
    fn drop(&mut self) {
        // SAFETY: the handle came from FwpmEngineOpen0 and is closed exactly once; closing also aborts a
        // transaction left open.
        unsafe {
            FwpmEngineClose0(self.handle);
        }
    }
}

impl WfpReader for Win32WfpReader {
    fn sublayer(&mut self, key: u128) -> io::Result<Option<InstalledSublayer>> {
        let guid = to_guid(key);
        let mut found: *mut FWPM_SUBLAYER0 = null_mut();
        // SAFETY: the key outlives the call; the engine allocates `found`, freed by `FwpmMemory`.
        let status = unsafe { FwpmSubLayerGetByKey0(self.handle, &guid, &mut found) };
        if status == FWP_E_SUBLAYER_NOT_FOUND as u32 {
            return Ok(None);
        }
        check(status)?;
        let _memory = FwpmMemory(found.cast());
        // SAFETY: a successful call returned a valid FWPM_SUBLAYER0.
        let sublayer = unsafe { &*found };
        let ours =
            sublayer.flags & FWPM_SUBLAYER_FLAG_PERSISTENT != 0 && sublayer.providerKey.is_null();
        // SAFETY: the engine's blob points at `size` valid bytes, or is empty.
        let provider_data = unsafe { blob_bytes(&sublayer.providerData) };
        Ok(Some(InstalledSublayer {
            key,
            provider_data,
            // A sublayer that is not persistent or names a provider is not one this module wrote, so it
            // reads back with a weight no plan uses and the applier refuses it.
            weight: if ours { sublayer.weight } else { 0 },
        }))
    }

    fn filter(&mut self, key: u128) -> io::Result<Option<InstalledFilter>> {
        let guid = to_guid(key);
        let mut found: *mut FWPM_FILTER0 = null_mut();
        // SAFETY: the key outlives the call; the engine allocates `found`, freed by `FwpmMemory`.
        let status = unsafe { FwpmFilterGetByKey0(self.handle, &guid, &mut found) };
        if status == FWP_E_FILTER_NOT_FOUND as u32 {
            return Ok(None);
        }
        check(status)?;
        let _memory = FwpmMemory(found.cast());
        // SAFETY: a successful call returned a valid FWPM_FILTER0 whose pointers live as long as it.
        let filter = unsafe { &*found };
        Ok(Some(read_filter(key, filter)?))
    }

    /// Enumerates every filter on the machine; ours are the ones whose sublayer matches. Not narrowed to the
    /// contract's layers: a filter of ours at any other layer is still one a readback must count and a revoke
    /// must delete.
    fn filters_in_sublayer(&mut self, sublayer: u128) -> io::Result<Vec<u128>> {
        const PAGE: u32 = 256;
        let mut keys = Vec::new();
        let mut raw: HANDLE = null_mut();
        // SAFETY: a null template enumerates every filter; the handle is destroyed by `EnumHandle`.
        check(unsafe { FwpmFilterCreateEnumHandle0(self.handle, null(), &mut raw) })?;
        let enumeration = EnumHandle {
            engine: self.handle,
            handle: raw,
        };
        loop {
            let mut entries: *mut *mut FWPM_FILTER0 = null_mut();
            let mut returned = 0u32;
            // SAFETY: valid handles; the engine allocates `entries`, freed by `FwpmMemory`.
            check(unsafe {
                FwpmFilterEnum0(
                    self.handle,
                    enumeration.handle,
                    PAGE,
                    &mut entries,
                    &mut returned,
                )
            })?;
            let _memory = FwpmMemory(entries.cast());
            for index in 0..returned as usize {
                // SAFETY: the engine returned `returned` valid filter pointers.
                let filter = unsafe { &**entries.add(index) };
                if guid_value(&filter.subLayerKey) == sublayer {
                    keys.push(guid_value(&filter.filterKey));
                }
            }
            if returned < PAGE {
                break;
            }
        }
        Ok(keys)
    }
}

/// A filter enumeration handle, destroyed exactly once.
struct EnumHandle {
    engine: HANDLE,
    handle: HANDLE,
}

impl Drop for EnumHandle {
    fn drop(&mut self) {
        // SAFETY: both handles are valid and this enumeration handle is destroyed only here.
        unsafe {
            FwpmFilterDestroyEnumHandle0(self.engine, self.handle);
        }
    }
}

pub(in crate::wfp) fn check(status: u32) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

pub(in crate::wfp) fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// Memory the filtering engine allocated, freed exactly once.
struct FwpmMemory(*mut c_void);

impl Drop for FwpmMemory {
    fn drop(&mut self) {
        let mut pointer = self.0;
        // SAFETY: the pointer came from an Fwpm* getter documented for FwpmFreeMemory0.
        unsafe { FwpmFreeMemory0(&mut pointer) };
    }
}


fn guid_value(guid: &GUID) -> u128 {
    (u128::from(guid.data1) << 96)
        | (u128::from(guid.data2) << 80)
        | (u128::from(guid.data3) << 64)
        | u128::from(u64::from_be_bytes(guid.data4))
}

/// A filter as this module would have written it, or one with no conditions if it is not.
fn read_filter(key: u128, filter: &FWPM_FILTER0) -> io::Result<InstalledFilter> {
    let rules = wfp_rules()?;
    let layer_value = guid_value(&filter.layerKey);
    let layer = rules
        .layer_keys
        .iter()
        .find(|(_, value)| **value == layer_value)
        .map(|(layer, _)| *layer);
    let action = match filter.action.r#type {
        FWP_ACTION_BLOCK => Some(FilterAction::Block),
        FWP_ACTION_PERMIT if filter.flags & FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT == 0 => {
            Some(FilterAction::SoftPermit)
        }
        _ => None,
    };
    // Any other weight type is reported as weight 0, which no plan carries, so it is replaced.
    let weight = match filter.weight.r#type {
        // SAFETY: the type tag says the union holds a uint8.
        FWP_UINT8 => unsafe { filter.weight.Anonymous.uint8 },
        _ => 0,
    };
    let ours = filter.flags & FWPM_FILTER_FLAG_PERSISTENT != 0 && filter.providerKey.is_null();
    // SAFETY: the engine returned `numFilterConditions` valid conditions at `filterCondition`, or a null
    // pointer with a zero count.
    let raw = unsafe { raw_slice(filter.filterCondition, filter.numFilterConditions as usize) }?;
    let conditions = match (layer, action, ours) {
        (Some(_), Some(_), true) => read_conditions(raw).unwrap_or_default(),
        _ => Vec::new(),
    };
    // SAFETY: the engine's blob points at `size` valid bytes, or is empty.
    let provider_data = unsafe { blob_bytes(&filter.providerData) };
    Ok(InstalledFilter {
        filter: DesiredFilter {
            key,
            layer: layer.unwrap_or(Layer::AleAuthConnectV4),
            conditions,
            action: action.unwrap_or(FilterAction::Block),
            weight,
        },
        sublayer: guid_value(&filter.subLayerKey),
        provider_data,
    })
}

/// A slice over engine memory. WFP may return a null pointer for an empty array, which `from_raw_parts`
/// must never see; a null pointer with a count is a malformed filter and is an error.
///
/// # Safety
/// A non-null `data` must point at `len` readable, initialised `T`s that outlive `'a`.
pub(in crate::wfp) unsafe fn raw_slice<'a, T>(data: *const T, len: usize) -> io::Result<&'a [T]> {
    if len == 0 {
        return Ok(&[]);
    }
    if data.is_null() {
        return Err(invalid("a filter reports conditions but no condition array"));
    }
    // SAFETY: guaranteed by the caller.
    Ok(unsafe { std::slice::from_raw_parts(data, len) })
}

/// # Safety
/// `blob.data` must point at `blob.size` readable bytes, or `blob.size` must be zero.
unsafe fn blob_bytes(blob: &FWP_BYTE_BLOB) -> Vec<u8> {
    if blob.size == 0 || blob.data.is_null() {
        return Vec::new();
    }
    // SAFETY: guaranteed by the caller.
    unsafe { std::slice::from_raw_parts(blob.data, blob.size as usize) }.to_vec()
}

/// The conditions in this module's fixed order, or `None` if any is not one it writes.
fn read_conditions(raw: &[FWPM_FILTER_CONDITION0]) -> Option<Vec<Condition>> {
    let mut user = None;
    let mut flag = None;
    let mut v4 = Vec::new();
    let mut v6 = Vec::new();
    let mut protocols = Vec::new();
    let mut ports = Vec::new();
    for condition in raw {
        let value = &condition.conditionValue;
        let field = guid_value(&condition.fieldKey);
        // SAFETY (each union read below): the variant read is the one `value.r#type` names.
        if field == guid_value(&FWPM_CONDITION_ALE_USER_ID) {
            if user.is_some()
                || condition.matchType != FWP_MATCH_EQUAL
                || value.r#type != FWP_SECURITY_DESCRIPTOR_TYPE
            {
                return None;
            }
            user = Some(unsafe { descriptor_user(value.Anonymous.sd) }?);
        } else if field == guid_value(&FWPM_CONDITION_FLAGS) {
            if flag.is_some()
                || value.r#type != FWP_UINT32
                || unsafe { value.Anonymous.uint32 } != FWP_CONDITION_FLAG_IS_LOOPBACK
            {
                return None;
            }
            flag = Some(match condition.matchType {
                FWP_MATCH_FLAGS_ALL_SET => true,
                FWP_MATCH_FLAGS_NONE_SET => false,
                _ => return None,
            });
        } else if field == guid_value(&FWPM_CONDITION_IP_REMOTE_ADDRESS) {
            let range = unsafe { read_range(condition) }?;
            match (range.valueLow.r#type, range.valueHigh.r#type) {
                (FWP_UINT32, FWP_UINT32) => v4.push(unsafe {
                    (
                        range.valueLow.Anonymous.uint32,
                        range.valueHigh.Anonymous.uint32,
                    )
                }),
                (FWP_BYTE_ARRAY16_TYPE, FWP_BYTE_ARRAY16_TYPE) => v6.push(unsafe {
                    (
                        u128::from_be_bytes((*range.valueLow.Anonymous.byteArray16).byteArray16),
                        u128::from_be_bytes((*range.valueHigh.Anonymous.byteArray16).byteArray16),
                    )
                }),
                _ => return None,
            }
        } else if field == guid_value(&FWPM_CONDITION_IP_PROTOCOL) {
            protocols.push(match (condition.matchType, value.r#type) {
                (FWP_MATCH_EQUAL, FWP_UINT8) => {
                    let number = unsafe { value.Anonymous.uint8 };
                    (number, number)
                }
                (FWP_MATCH_RANGE, FWP_RANGE_TYPE) => {
                    let range = unsafe { &*value.Anonymous.rangeValue };
                    if range.valueLow.r#type != FWP_UINT8 || range.valueHigh.r#type != FWP_UINT8 {
                        return None;
                    }
                    unsafe {
                        (
                            range.valueLow.Anonymous.uint8,
                            range.valueHigh.Anonymous.uint8,
                        )
                    }
                }
                _ => return None,
            });
        } else if field == guid_value(&FWPM_CONDITION_IP_REMOTE_PORT) {
            ports.push(match (condition.matchType, value.r#type) {
                (FWP_MATCH_EQUAL, FWP_UINT16) => {
                    let number = unsafe { value.Anonymous.uint16 };
                    (number, number)
                }
                (FWP_MATCH_RANGE, FWP_RANGE_TYPE) => {
                    let range = unsafe { &*value.Anonymous.rangeValue };
                    if range.valueLow.r#type != FWP_UINT16 || range.valueHigh.r#type != FWP_UINT16 {
                        return None;
                    }
                    unsafe {
                        (
                            range.valueLow.Anonymous.uint16,
                            range.valueHigh.Anonymous.uint16,
                        )
                    }
                }
                _ => return None,
            });
        } else {
            return None;
        }
    }
    let mut conditions = vec![Condition::User(user?)];
    conditions.extend(flag.map(Condition::LoopbackFlag));
    if !v4.is_empty() {
        v4.sort_unstable();
        conditions.push(Condition::RemoteV4(v4));
    }
    if !v6.is_empty() {
        v6.sort_unstable();
        conditions.push(Condition::RemoteV6(v6));
    }
    if !protocols.is_empty() {
        protocols.sort_unstable();
        conditions.push(Condition::Protocol(protocols));
    }
    if !ports.is_empty() {
        ports.sort_unstable();
        conditions.push(Condition::RemotePort(ports));
    }
    Some(conditions)
}

/// # Safety
/// The condition's value, if it is a range, must point at a valid FWP_RANGE0.
unsafe fn read_range(condition: &FWPM_FILTER_CONDITION0) -> Option<&FWP_RANGE0> {
    if condition.matchType != FWP_MATCH_RANGE || condition.conditionValue.r#type != FWP_RANGE_TYPE {
        return None;
    }
    // SAFETY: guaranteed by the caller for a range-typed value.
    Some(unsafe { &*condition.conditionValue.Anonymous.rangeValue })
}

/// The account an `ALE_USER_ID` descriptor matches: its DACL must be exactly one allow ACE, with no ACE
/// flags, granting `FWP_ACTRL_MATCH_FILTER`, which is the only shape this module writes. A flagged ACE
/// is drift: an inherit-only one grants nothing in the access check, so it would match no token.
///
/// # Safety
/// `blob` must point at a valid FWP_BYTE_BLOB holding a self-relative security descriptor.
unsafe fn descriptor_user(blob: *const FWP_BYTE_BLOB) -> Option<String> {
    if blob.is_null() {
        return None;
    }
    // SAFETY: guaranteed by the caller.
    let descriptor = unsafe { (*blob).data }.cast::<c_void>();
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl: *mut ACL = null_mut();
    // SAFETY: a valid descriptor; the DACL pointer points into it.
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
        == 0
        || present == 0
        || dacl.is_null()
        || unsafe { (*dacl).AceCount } != 1
    {
        return None;
    }
    let mut ace: *mut c_void = null_mut();
    // SAFETY: index 0 exists, as AceCount is 1.
    if unsafe { GetAce(dacl, 0, &mut ace) } == 0 || ace.is_null() {
        return None;
    }
    // SAFETY: GetAce returned a valid ACE header.
    let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
    if allowed.Header.AceType != ACCESS_ALLOWED_ACE_TYPE
        || allowed.Header.AceFlags != 0
        || allowed.Mask != FWP_ACTRL_MATCH_FILTER
    {
        return None;
    }
    let sid = (&allowed.SidStart as *const u32)
        .cast_mut()
        .cast::<c_void>();
    sid_to_string(sid).ok()
}

#[cfg(test)]
mod tests {
    use super::descriptor_user;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::FWP_BYTE_BLOB;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::PSECURITY_DESCRIPTOR;

    const SID: &str = "S-1-5-21-1-2-3-1001";

    /// Reads the user out of a descriptor built from SDDL, as the writer builds it.
    fn user_of(sddl: &str) -> Option<String> {
        let wide: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let mut length = 0u32;
        // SAFETY: NUL-terminated UTF-16 in; LocalAlloc memory out, freed below.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                &mut length,
            )
        };
        assert_ne!(converted, 0, "the SDDL converts");
        let blob = FWP_BYTE_BLOB {
            size: length,
            data: descriptor.cast(),
        };
        // SAFETY: the blob holds the self-relative descriptor just converted.
        let user = unsafe { descriptor_user(&blob) };
        // SAFETY: the descriptor came from LocalAlloc and is not used again.
        unsafe { LocalFree(descriptor) };
        user
    }

    #[test]
    fn the_descriptor_the_writer_builds_reads_back_as_its_user() {
        assert_eq!(
            user_of(&format!("O:LSD:(A;;CC;;;{SID})")).as_deref(),
            Some(SID)
        );
    }

    #[test]
    fn an_inherit_only_ace_grants_nothing_so_reads_back_as_no_user() {
        assert_eq!(user_of(&format!("O:LSD:(A;IO;CC;;;{SID})")), None);
    }

    #[test]
    fn any_ace_flag_the_writer_does_not_set_reads_back_as_no_user() {
        assert_eq!(user_of(&format!("O:LSD:(A;CI;CC;;;{SID})")), None);
        assert_eq!(user_of(&format!("O:LSD:(A;OICIIO;CC;;;{SID})")), None);
    }
}

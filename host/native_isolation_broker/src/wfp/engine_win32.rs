//! The real filtering engine, to write: `fwpuclnt.dll` behind the `WfpEngine` seam.
//!
//! Compiled only by the elevated broker. The reads it needs come from `read::engine`, over the same
//! handle, so a transaction sees what it has staged.
//!
//! The session is not dynamic: a dynamic session cannot add persistent objects, and everything it adds
//! goes when its handle closes. Every object is persistent, names no provider and carries the plan's
//! `providerData` tag. A filter's `ALE_USER_ID` condition is a security descriptor granting the tier
//! account `FWP_ACTRL_MATCH_FILTER`, the shape the S1 spike measured; each object's own descriptor
//! grants the owner read, so a readback needs no elevation.

use super::apply::WfpEngine;
use super::read::contract::wfp_rules;
use super::read::engine::{Win32WfpReader, check, invalid};
use super::read::filters::{Condition, FilterAction};
use super::read::key::to_guid;
use super::read::{InstalledFilter, InstalledSublayer, WfpReader};
use crate::process_win32::wide_null;
use crate::sid_win32::LocalAllocation;
use std::io;
use std::ptr::null_mut;
use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::PSECURITY_DESCRIPTOR;
use windows_sys::core::GUID;

pub(crate) struct Win32WfpEngine {
    reader: Win32WfpReader,
    owner_sid: String,
}

impl Win32WfpEngine {
    /// Opens a non-dynamic session. `owner_sid` is granted read on every object this session adds.
    pub(crate) fn open(owner_sid: &str) -> io::Result<Self> {
        Ok(Self {
            reader: Win32WfpReader::open()?,
            owner_sid: owner_sid.to_owned(),
        })
    }
}

impl WfpReader for Win32WfpEngine {
    fn sublayer(&mut self, key: u128) -> io::Result<Option<InstalledSublayer>> {
        self.reader.sublayer(key)
    }

    fn filter(&mut self, key: u128) -> io::Result<Option<InstalledFilter>> {
        self.reader.filter(key)
    }

    fn filters_in_sublayer(&mut self, sublayer: u128) -> io::Result<Vec<u128>> {
        self.reader.filters_in_sublayer(sublayer)
    }
}

impl WfpEngine for Win32WfpEngine {
    fn begin(&mut self) -> io::Result<()> {
        // SAFETY: a valid engine handle; flags 0 is a read-write transaction.
        check(unsafe { FwpmTransactionBegin0(self.reader.handle, 0) })
    }

    fn commit(&mut self) -> io::Result<()> {
        // SAFETY: a valid engine handle.
        check(unsafe { FwpmTransactionCommit0(self.reader.handle) })
    }

    fn abort(&mut self) -> io::Result<()> {
        // SAFETY: a valid engine handle.
        check(unsafe { FwpmTransactionAbort0(self.reader.handle) })
    }

    fn add_sublayer(&mut self, sublayer: &InstalledSublayer) -> io::Result<()> {
        let name = wide_null("SuperClaw egress");
        let description = wide_null("Per-account egress filters for SuperClaw's isolation tiers");
        let mut data = sublayer.provider_data.clone();
        // SAFETY: FWPM_SUBLAYER0 is a plain C struct; every field is set below or valid as zero.
        let mut record: FWPM_SUBLAYER0 = unsafe { std::mem::zeroed() };
        record.subLayerKey = to_guid(sublayer.key);
        record.displayData.name = name.as_ptr().cast_mut();
        record.displayData.description = description.as_ptr().cast_mut();
        record.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
        record.providerData = FWP_BYTE_BLOB {
            size: data.len() as u32,
            data: data.as_mut_ptr(),
        };
        record.weight = sublayer.weight;
        let descriptor = object_descriptor(&self.owner_sid)?;
        // SAFETY: every pointer in `record` and the descriptor outlives the call.
        check(unsafe { FwpmSubLayerAdd0(self.reader.handle, &record, descriptor.descriptor()) })
    }

    fn add_filter(&mut self, filter: &InstalledFilter) -> io::Result<()> {
        let rules = wfp_rules()?;
        let layer_key = *rules
            .layer_keys
            .get(&filter.filter.layer)
            .ok_or_else(|| invalid("a filter names a layer the contract has no key for"))?;
        let name = wide_null("SuperClaw egress filter");
        let mut data = filter.provider_data.clone();
        let mut storage = ConditionStorage::default();
        let mut conditions = Vec::new();
        for condition in &filter.filter.conditions {
            storage.write(condition, &mut conditions)?;
        }
        // SAFETY: FWPM_FILTER0 is a plain C struct; every field is set below or valid as zero.
        let mut record: FWPM_FILTER0 = unsafe { std::mem::zeroed() };
        record.filterKey = to_guid(filter.filter.key);
        record.displayData.name = name.as_ptr().cast_mut();
        // No FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT, ever: a soft permit is what keeps `log_only` from
        // overriding anybody's block, and a block needs no help.
        record.flags = FWPM_FILTER_FLAG_PERSISTENT;
        record.providerData = FWP_BYTE_BLOB {
            size: data.len() as u32,
            data: data.as_mut_ptr(),
        };
        // A UINT8 weight is a range, 0 to 15, and a higher range is evaluated first: the contract's
        // class weights put the upstream permit ahead of the internal block it opens.
        record.weight = uint8_value(filter.filter.weight);
        record.layerKey = to_guid(layer_key);
        record.subLayerKey = to_guid(filter.sublayer);
        record.numFilterConditions = conditions.len() as u32;
        record.filterCondition = conditions.as_mut_ptr();
        record.action.r#type = match filter.filter.action {
            FilterAction::Block => FWP_ACTION_BLOCK,
            FilterAction::SoftPermit => FWP_ACTION_PERMIT,
        };
        let descriptor = object_descriptor(&self.owner_sid)?;
        let mut id = 0u64;
        // SAFETY: `record` points into `conditions`, `storage`, `name` and `data`, all of which outlive
        // the call, as does the descriptor.
        check(unsafe { FwpmFilterAdd0(self.reader.handle, &record, descriptor.descriptor(), &mut id) })
    }

    fn delete_filter(&mut self, key: u128) -> io::Result<()> {
        let guid = to_guid(key);
        // SAFETY: the key outlives the call.
        check(unsafe { FwpmFilterDeleteByKey0(self.reader.handle, &guid) })
    }

    fn delete_sublayer(&mut self, key: u128) -> io::Result<()> {
        let guid = to_guid(key);
        // SAFETY: the key outlives the call.
        check(unsafe { FwpmSubLayerDeleteByKey0(self.reader.handle, &guid) })
    }
}

/// A self-relative security descriptor converted from SDDL, with its length.
struct Descriptor {
    memory: LocalAllocation,
    length: u32,
}

impl Descriptor {
    fn from_sddl(sddl: &str) -> io::Result<Self> {
        let wide = wide_null(sddl);
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let mut length = 0u32;
        // SAFETY: the SDDL is NUL-terminated UTF-16; the output is LocalAlloc memory owned below.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                &mut length,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            memory: LocalAllocation::new(descriptor)?,
            length,
        })
    }

    fn descriptor(&self) -> PSECURITY_DESCRIPTOR {
        self.memory.pointer()
    }
}

/// The descriptor every object gets: full control for SYSTEM and Administrators, read for the owner.
fn object_descriptor(owner_sid: &str) -> io::Result<Descriptor> {
    Descriptor::from_sddl(&format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GR;;;{owner_sid})"))
}

/// The buffers a filter's conditions point into, kept alive until the add returns. Boxed, so a pointer
/// taken into one stays valid as more are pushed.
#[allow(clippy::vec_box)]
#[derive(Default)]
struct ConditionStorage {
    descriptors: Vec<Descriptor>,
    blobs: Vec<Box<FWP_BYTE_BLOB>>,
    ranges: Vec<Box<FWP_RANGE0>>,
    arrays: Vec<Box<FWP_BYTE_ARRAY16>>,
}

impl ConditionStorage {
    fn write(
        &mut self,
        condition: &Condition,
        out: &mut Vec<FWPM_FILTER_CONDITION0>,
    ) -> io::Result<()> {
        match condition {
            Condition::User(sid) => {
                let descriptor = Descriptor::from_sddl(&format!("O:LSD:(A;;CC;;;{sid})"))?;
                let mut blob = Box::new(FWP_BYTE_BLOB {
                    size: descriptor.length,
                    data: descriptor.descriptor().cast(),
                });
                let mut value = empty_condition_value();
                value.r#type = FWP_SECURITY_DESCRIPTOR_TYPE;
                value.Anonymous.sd = &mut *blob;
                out.push(condition_record(
                    FWPM_CONDITION_ALE_USER_ID,
                    FWP_MATCH_EQUAL,
                    value,
                ));
                self.descriptors.push(descriptor);
                self.blobs.push(blob);
            }
            Condition::LoopbackFlag(set) => {
                let mut value = empty_condition_value();
                value.r#type = FWP_UINT32;
                value.Anonymous.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
                let match_type = if *set {
                    FWP_MATCH_FLAGS_ALL_SET
                } else {
                    FWP_MATCH_FLAGS_NONE_SET
                };
                out.push(condition_record(FWPM_CONDITION_FLAGS, match_type, value));
            }
            Condition::RemoteV4(ranges) => {
                for &(first, last) in ranges {
                    let low = uint32_value(first);
                    let high = uint32_value(last);
                    out.push(self.range(FWPM_CONDITION_IP_REMOTE_ADDRESS, low, high));
                }
            }
            Condition::RemoteV6(ranges) => {
                for &(first, last) in ranges {
                    let low = self.array16(first);
                    let high = self.array16(last);
                    out.push(self.range(FWPM_CONDITION_IP_REMOTE_ADDRESS, low, high));
                }
            }
            Condition::Protocol(ranges) => {
                for &(first, last) in ranges {
                    if first == last {
                        let mut value = empty_condition_value();
                        value.r#type = FWP_UINT8;
                        value.Anonymous.uint8 = first;
                        out.push(condition_record(
                            FWPM_CONDITION_IP_PROTOCOL,
                            FWP_MATCH_EQUAL,
                            value,
                        ));
                    } else {
                        out.push(self.range(
                            FWPM_CONDITION_IP_PROTOCOL,
                            uint8_value(first),
                            uint8_value(last),
                        ));
                    }
                }
            }
            Condition::RemotePort(ranges) => {
                for &(first, last) in ranges {
                    if first == last {
                        let mut value = empty_condition_value();
                        value.r#type = FWP_UINT16;
                        value.Anonymous.uint16 = first;
                        out.push(condition_record(
                            FWPM_CONDITION_IP_REMOTE_PORT,
                            FWP_MATCH_EQUAL,
                            value,
                        ));
                    } else {
                        out.push(self.range(
                            FWPM_CONDITION_IP_REMOTE_PORT,
                            uint16_value(first),
                            uint16_value(last),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    fn range(&mut self, field: GUID, low: FWP_VALUE0, high: FWP_VALUE0) -> FWPM_FILTER_CONDITION0 {
        let mut range = Box::new(FWP_RANGE0 {
            valueLow: low,
            valueHigh: high,
        });
        let mut value = empty_condition_value();
        value.r#type = FWP_RANGE_TYPE;
        value.Anonymous.rangeValue = &mut *range;
        self.ranges.push(range);
        condition_record(field, FWP_MATCH_RANGE, value)
    }

    /// An IPv6 address as WFP takes it: sixteen bytes in network order.
    fn array16(&mut self, address: u128) -> FWP_VALUE0 {
        let mut array = Box::new(FWP_BYTE_ARRAY16 {
            byteArray16: address.to_be_bytes(),
        });
        // SAFETY: FWP_VALUE0 is a plain C struct; all-zero is FWP_EMPTY.
        let mut value: FWP_VALUE0 = unsafe { std::mem::zeroed() };
        value.r#type = FWP_BYTE_ARRAY16_TYPE;
        value.Anonymous.byteArray16 = &mut *array;
        self.arrays.push(array);
        value
    }
}

fn empty_condition_value() -> FWP_CONDITION_VALUE0 {
    // SAFETY: FWP_CONDITION_VALUE0 is a plain C struct; all-zero is FWP_EMPTY.
    unsafe { std::mem::zeroed() }
}

fn condition_record(
    field: GUID,
    match_type: FWP_MATCH_TYPE,
    value: FWP_CONDITION_VALUE0,
) -> FWPM_FILTER_CONDITION0 {
    FWPM_FILTER_CONDITION0 {
        fieldKey: field,
        matchType: match_type,
        conditionValue: value,
    }
}

fn uint8_value(number: u8) -> FWP_VALUE0 {
    // SAFETY: FWP_VALUE0 is a plain C struct; all-zero is FWP_EMPTY.
    let mut value: FWP_VALUE0 = unsafe { std::mem::zeroed() };
    value.r#type = FWP_UINT8;
    value.Anonymous.uint8 = number;
    value
}

fn uint16_value(number: u16) -> FWP_VALUE0 {
    // SAFETY: FWP_VALUE0 is a plain C struct; all-zero is FWP_EMPTY.
    let mut value: FWP_VALUE0 = unsafe { std::mem::zeroed() };
    value.r#type = FWP_UINT16;
    value.Anonymous.uint16 = number;
    value
}

/// An IPv4 address as WFP takes it: a host-order 32-bit number.
fn uint32_value(number: u32) -> FWP_VALUE0 {
    // SAFETY: FWP_VALUE0 is a plain C struct; all-zero is FWP_EMPTY.
    let mut value: FWP_VALUE0 = unsafe { std::mem::zeroed() };
    value.r#type = FWP_UINT32;
    value.Anonymous.uint32 = number;
    value
}


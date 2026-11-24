//! Descriptor right names and inheritance words to Win32 access masks and ACE flags.
//!
//! # Why this is its own module
//!
//! Two components need the same translation and only one of them may hold privilege. The elevated
//! broker turns a plan's `rights` list into an SDDL mask so it can apply a descriptor
//! (`acl_policy_apply.rs`); the unelevated launcher turns the *shipped* descriptor's `rights` lists
//! into the masks it expects to read back from a managed root (`managed_root_dacl.rs`). If each side
//! carried its own table they could drift, and a drift check that computed a different mask from the
//! same words would either pass a wrong DACL or fail a right one.
//!
//! Nothing here touches an object, opens a handle or resolves a principal: it is a total function
//! from contract vocabulary to bits, which is exactly why it is safe to put inside the launcher's
//! module closure.

use windows_sys::Win32::Security::{CONTAINER_INHERIT_ACE, INHERIT_ONLY_ACE, OBJECT_INHERIT_ACE};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_APPEND_DATA, FILE_DELETE_CHILD, FILE_EXECUTE, FILE_READ_ATTRIBUTES,
    FILE_READ_DATA, FILE_READ_EA, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA,
    READ_CONTROL, SYNCHRONIZE, WRITE_DAC, WRITE_OWNER,
};

/// The two ACE types this crate can interpret. Anything else in a DACL is a shape neither side
/// models, and both sides refuse rather than skip it.
pub const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
pub const ACCESS_DENIED_ACE_TYPE: u8 = 1;

/// Set on an ACE that arrived by inheritance rather than by being written to this object. A managed
/// root's DACL is protected, so an inherited ACE on one is evidence the protection was lifted.
pub const INHERITED_ACE_FLAG: u8 = 0x10;

pub const LOCAL_SYSTEM_SID: &str = "S-1-5-18";
pub const ADMINISTRATORS_SID: &str = "S-1-5-32-544";

/// Every right name the ACL policy descriptor may use, in the order an observation lists them.
///
/// The order is part of the C3 observation shape rather than an implementation detail: a consumer
/// comparing two observations compares the lists, so reordering this would change the contract.
pub const RIGHT_BITS: &[(&str, u32)] = &[
    ("FILE_READ_DATA", FILE_READ_DATA),
    ("FILE_WRITE_DATA", FILE_WRITE_DATA),
    ("FILE_APPEND_DATA", FILE_APPEND_DATA),
    ("FILE_READ_EA", FILE_READ_EA),
    ("FILE_WRITE_EA", FILE_WRITE_EA),
    ("FILE_EXECUTE", FILE_EXECUTE),
    ("FILE_DELETE_CHILD", FILE_DELETE_CHILD),
    ("FILE_READ_ATTRIBUTES", FILE_READ_ATTRIBUTES),
    ("FILE_WRITE_ATTRIBUTES", FILE_WRITE_ATTRIBUTES),
    ("DELETE", DELETE),
    ("READ_CONTROL", READ_CONTROL),
    ("WRITE_DAC", WRITE_DAC),
    ("WRITE_OWNER", WRITE_OWNER),
    ("SYNCHRONIZE", SYNCHRONIZE),
];

pub fn right_to_bit(name: &str) -> Option<u32> {
    RIGHT_BITS
        .iter()
        .find(|(candidate, _)| *candidate == name)
        .map(|(_, bit)| *bit)
}

/// Folds a list of right names into one mask, naming the first unknown one rather than ignoring it.
pub fn rights_to_mask<'a>(names: impl IntoIterator<Item = &'a str>) -> Result<u32, String> {
    let mut mask = 0u32;
    for name in names {
        mask |= right_to_bit(name).ok_or_else(|| format!("unknown ACL right: {name}"))?;
    }
    Ok(mask)
}

pub fn mask_to_rights(mask: u32) -> Vec<String> {
    RIGHT_BITS
        .iter()
        .filter(|(_, bit)| mask & *bit != 0)
        .map(|(name, _)| (*name).to_owned())
        .collect()
}

/// The ACE flag byte a descriptor inheritance word means.
pub fn inheritance_to_ace_flags(inheritance: &str) -> Option<u8> {
    let object = OBJECT_INHERIT_ACE as u8;
    let container = CONTAINER_INHERIT_ACE as u8;
    let inherit_only = INHERIT_ONLY_ACE as u8;
    match inheritance {
        "this_object_only" => Some(0),
        "this_object_and_children" => Some(object | container),
        "children_only" => Some(object | container | inherit_only),
        _ => None,
    }
}

/// The SDDL flag letters a descriptor inheritance word means. The counterpart of
/// `inheritance_to_ace_flags` for the apply path, which goes through SDDL rather than raw flags.
pub fn inheritance_to_sddl_flags(inheritance: &str) -> &'static str {
    match inheritance {
        "this_object_and_children" => "OICI",
        "children_only" => "OICIIO",
        _ => "",
    }
}

/// The descriptor word an observed ACE flag byte reads back as.
pub fn inheritance_from_flags(flags: u8) -> &'static str {
    let flags = flags as u32;
    if flags & INHERIT_ONLY_ACE != 0 {
        "children_only"
    } else if flags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) != 0 {
        "this_object_and_children"
    } else {
        "this_object_only"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_right_name_round_trips_through_its_bit() {
        for (name, bit) in RIGHT_BITS {
            assert_eq!(right_to_bit(name), Some(*bit));
            assert_eq!(mask_to_rights(*bit), vec![(*name).to_owned()]);
        }
        assert_eq!(right_to_bit("GENERIC_ALL"), None);
    }

    #[test]
    fn an_unknown_right_is_named_rather_than_dropped() {
        assert_eq!(
            rights_to_mask(["FILE_READ_DATA", "DELETE"]).expect("known rights fold"),
            FILE_READ_DATA | DELETE
        );
        assert_eq!(
            rights_to_mask(["FILE_READ_DATA", "GENERIC_ALL"]),
            Err("unknown ACL right: GENERIC_ALL".to_owned())
        );
    }

    /// Both directions of the inheritance mapping have to agree, or an ACE the broker wrote through
    /// SDDL would read back as a different word than the descriptor used and the drift check would
    /// reject a correct DACL.
    #[test]
    fn every_inheritance_word_survives_the_round_trip_through_ace_flags() {
        for word in [
            "this_object_only",
            "this_object_and_children",
            "children_only",
        ] {
            let flags = inheritance_to_ace_flags(word).expect("a descriptor word maps to flags");
            assert_eq!(
                inheritance_from_flags(flags),
                word,
                "{word} did not round trip"
            );
        }
        assert_eq!(inheritance_to_ace_flags("everything"), None);
    }

    /// The SDDL letters and the raw flags are two spellings of one decision, so they must not be
    /// able to disagree.
    #[test]
    fn the_sddl_letters_spell_the_same_flags_as_the_ace_byte() {
        for (word, letters) in [
            ("this_object_only", ""),
            ("this_object_and_children", "OICI"),
            ("children_only", "OICIIO"),
        ] {
            assert_eq!(inheritance_to_sddl_flags(word), letters);
            let flags = inheritance_to_ace_flags(word).expect("a descriptor word maps to flags");
            assert_eq!(
                letters.contains("IO"),
                flags as u32 & INHERIT_ONLY_ACE != 0,
                "{word} disagrees about inherit-only"
            );
            assert_eq!(
                letters.contains("OI"),
                flags as u32 & OBJECT_INHERIT_ACE != 0,
                "{word} disagrees about object inheritance"
            );
        }
    }

    #[test]
    fn an_inherited_ace_is_distinguishable_from_a_written_one() {
        let written = inheritance_to_ace_flags("this_object_and_children").expect("flags");
        assert_eq!(written & INHERITED_ACE_FLAG, 0);
        assert_ne!((written | INHERITED_ACE_FLAG) & INHERITED_ACE_FLAG, 0);
    }
}

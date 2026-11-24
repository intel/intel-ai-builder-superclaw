use super::*;
use crate::process_win32::JOB_EXIT_CODE;
use serde_json::Value;
use std::collections::HashSet;

const KEY: &[u8] = b"01234567890123456789012345678901";
const NONCE: &str = "00112233445566778899aabbccddeeff";
const PIPE_ID: &str = "0123456789abcdef0123456789abcdef";

fn handoff() -> Handoff {
    Handoff {
        station_handle: 0x1a4,
        desktop_handle: 0x1a8,
        supervisor_pid: 4242 * 4,
        supervisor_process_handle: 0x1b0,
        supervisor_thread_handle: 0x1b4,
    }
}

fn sealed() -> Vec<u8> {
    seal(&handoff(), "bootstrap", NONCE.to_owned(), KEY).expect("a valid handoff seals")
}

fn envelope() -> serde_json::Map<String, Value> {
    match serde_json::from_slice(&sealed()).expect("the sealed frame is JSON") {
        Value::Object(object) => object,
        other => panic!("the sealed frame is not an object: {other}"),
    }
}

fn reopen(object: &serde_json::Map<String, Value>) -> Result<Handoff, HandoffError> {
    open(
        &serde_json::to_vec(object).expect("serialize"),
        "bootstrap",
        KEY,
    )
}

#[test]
fn a_sealed_handoff_opens_to_exactly_what_was_sealed() {
    assert_eq!(open(&sealed(), "bootstrap", KEY), Ok(handoff()));
    assert!(sealed().len() <= MAX_HANDOFF_FRAME_BYTES);
}

#[test]
fn an_unknown_field_is_refused_in_the_envelope_and_in_the_handoff() {
    let mut extra = envelope();
    extra.insert("executable".to_owned(), Value::from("C:\\Windows\\cmd.exe"));
    assert_eq!(
        reopen(&extra),
        Err(HandoffError::Frame(FrameError::InvalidJson))
    );

    let mut inner = envelope();
    inner["handoff"]
        .as_object_mut()
        .expect("the handoff is an object")
        .insert("desktop_name".to_owned(), Value::from("Default"));
    assert_eq!(
        reopen(&inner),
        Err(HandoffError::Frame(FrameError::InvalidJson))
    );

    let mut missing = envelope();
    missing["handoff"]
        .as_object_mut()
        .expect("the handoff is an object")
        .remove("supervisor_thread_handle");
    assert_eq!(
        reopen(&missing),
        Err(HandoffError::Frame(FrameError::InvalidJson))
    );
}

#[test]
fn a_body_over_the_handoff_bound_is_refused_before_it_is_parsed() {
    assert_eq!(
        open(&vec![b' '; MAX_HANDOFF_FRAME_BYTES + 1], "bootstrap", KEY),
        Err(HandoffError::Frame(FrameError::Oversized))
    );
    let mut padded = envelope();
    padded.insert("nonce".to_owned(), Value::from("a".repeat(2048)));
    assert_eq!(
        reopen(&padded),
        Err(HandoffError::Frame(FrameError::Oversized))
    );
}

#[test]
fn a_tampered_or_foreign_frame_fails_its_mac() {
    let mut tampered = envelope();
    tampered["handoff"]["desktop_handle"] = Value::from(0x2a0);
    assert_eq!(
        reopen(&tampered),
        Err(HandoffError::Frame(FrameError::InvalidMac))
    );
    let mut wrong_mac = envelope();
    wrong_mac["mac"] = Value::from("00".repeat(32));
    assert_eq!(
        reopen(&wrong_mac),
        Err(HandoffError::Frame(FrameError::InvalidMac))
    );
    assert_eq!(
        open(&sealed(), "bootstrap", b"another key of thirty two bytes!"),
        Err(HandoffError::Frame(FrameError::InvalidMac))
    );
}

#[test]
fn a_frame_for_another_tier_or_version_is_refused() {
    assert_eq!(
        open(&sealed(), "file_tool", KEY),
        Err(HandoffError::TierMismatch)
    );
    let mut version = envelope();
    version["version"] = Value::from(HANDOFF_VERSION + 1);
    assert_eq!(
        reopen(&version),
        Err(HandoffError::Frame(FrameError::UnsupportedVersion))
    );
}

#[test]
fn a_value_of_the_wrong_type_is_refused_rather_than_coerced() {
    for (field, value) in [
        ("station_handle", Value::from("0x1a4")),
        ("desktop_handle", Value::from(-4)),
        ("supervisor_pid", Value::from(16968.5)),
        ("supervisor_process_handle", Value::Null),
        ("supervisor_thread_handle", Value::from(true)),
        ("supervisor_pid", Value::from(u64::from(u32::MAX) + 4)),
    ] {
        let mut wrong = envelope();
        wrong["handoff"][field] = value.clone();
        assert_eq!(
            reopen(&wrong),
            Err(HandoffError::Frame(FrameError::InvalidJson)),
            "{field} = {value}"
        );
    }
    let mut nonce = envelope();
    nonce["nonce"] = Value::from(7);
    assert_eq!(
        reopen(&nonce),
        Err(HandoffError::Frame(FrameError::InvalidJson))
    );
}

/// A process id is any non-zero value: Windows does not promise ids are multiples of four, so the frame
/// does not ask for it.
#[test]
fn any_non_zero_process_id_is_accepted() {
    for pid in [1, 4243, u32::MAX] {
        let reported = Handoff {
            supervisor_pid: pid,
            ..handoff()
        };
        let sealed = seal(&reported, "bootstrap", NONCE.to_owned(), KEY).expect("seals");
        assert_eq!(open(&sealed, "bootstrap", KEY), Ok(reported), "{pid}");
    }
}

/// A handle value is a multiple of four from four, and a process id is non-zero. Anything else cannot
/// denote what it claims, and is refused on both sides of the frame.
#[test]
fn a_value_no_handle_or_process_id_can_have_is_refused_on_both_sides() {
    for broken in [
        Handoff {
            station_handle: 0,
            ..handoff()
        },
        Handoff {
            desktop_handle: 0x1a9,
            ..handoff()
        },
        Handoff {
            supervisor_process_handle: u64::from(u32::MAX) + 1,
            ..handoff()
        },
        Handoff {
            supervisor_pid: 0,
            ..handoff()
        },
        Handoff {
            supervisor_thread_handle: 2,
            ..handoff()
        },
    ] {
        assert_eq!(
            seal(&broken, "bootstrap", NONCE.to_owned(), KEY),
            Err(HandoffError::Frame(FrameError::InvalidField)),
            "{broken:?} sealed"
        );
        let mut forged = envelope();
        forged["handoff"] = serde_json::to_value(broken).expect("serialize");
        let forged_mac = {
            let body = seal_unchecked_for_test(&broken);
            serde_json::from_slice::<Value>(&body).expect("JSON")["mac"].clone()
        };
        forged["mac"] = forged_mac;
        assert_eq!(
            reopen(&forged),
            Err(HandoffError::Frame(FrameError::InvalidField)),
            "{broken:?} opened"
        );
    }
}

/// A frame body the sealing side refuses to produce, with a valid MAC, so the opening side's own check
/// is what refuses it.
fn seal_unchecked_for_test(handoff: &Handoff) -> Vec<u8> {
    let mut body: Value = serde_json::from_slice(&sealed()).expect("JSON");
    body["handoff"] = serde_json::to_value(handoff).expect("serialize");
    body["mac"] =
        Value::from(crate::frame::mac_hex(&authenticated_for_test(handoff), KEY).expect("mac"));
    serde_json::to_vec(&body).expect("serialize")
}

fn authenticated_for_test(handoff: &Handoff) -> Vec<u8> {
    super::authenticated(HANDOFF_VERSION, "bootstrap", NONCE, handoff).expect("authenticated bytes")
}

#[test]
fn a_short_nonce_is_refused() {
    assert_eq!(
        seal(&handoff(), "bootstrap", "short".to_owned(), KEY),
        Err(HandoffError::Frame(FrameError::InvalidField))
    );
}

#[test]
fn every_refusal_class_has_its_own_code() {
    let codes = [
        HandoffError::Frame(FrameError::Oversized),
        HandoffError::Frame(FrameError::InvalidJson),
        HandoffError::Frame(FrameError::UnsupportedVersion),
        HandoffError::Frame(FrameError::InvalidField),
        HandoffError::Frame(FrameError::InvalidMac),
        HandoffError::TierMismatch,
    ]
    .map(HandoffError::code);
    let unique: HashSet<&str> = codes.iter().copied().collect();
    assert_eq!(unique.len(), codes.len(), "{codes:?}");
}

#[test]
fn the_bootstrap_command_line_round_trips_and_names_nothing_else() {
    let args = BootstrapArgs {
        tier: IsolationTier::FileTool,
        pipe_id: PIPE_ID.to_owned(),
        key_hex: "ab".repeat(32),
        owner_sid: "S-1-5-21-1-2-3-1001".to_owned(),
        role_desktop_boundary: false,
    };
    let command = bootstrap_command_line(
        Path::new(r"C:\Program Files\SuperClaw\native_isolation_tier_bootstrap.exe"),
        &args,
    );
    assert_eq!(
        command,
        format!(
            "\"C:\\Program Files\\SuperClaw\\native_isolation_tier_bootstrap.exe\" --tier file_tool \
             --pipe-id {PIPE_ID} --auth-key {} --owner-sid S-1-5-21-1-2-3-1001",
            "ab".repeat(32)
        )
    );
    // The quoted image path holds one space, so the arguments start at the third word.
    let parsed: Vec<String> = command
        .split_whitespace()
        .skip(2)
        .map(str::to_owned)
        .collect();
    assert_eq!(parse_bootstrap_args(&parsed).expect("round trip"), args);

    let flagged = BootstrapArgs {
        role_desktop_boundary: true,
        ..args
    };
    let command = bootstrap_command_line(
        Path::new(r"C:\Program Files\SuperClaw\native_isolation_tier_bootstrap.exe"),
        &flagged,
    );
    assert!(command.ends_with(" --role-desktop-boundary"), "{command}");
    let parsed: Vec<String> = command
        .split_whitespace()
        .skip(2)
        .map(str::to_owned)
        .collect();
    assert_eq!(
        parse_bootstrap_args(&parsed).expect("flagged round trip"),
        flagged
    );
}

#[test]
fn the_bootstrap_refuses_any_other_argument_shape() {
    let good = [
        "--tier",
        "bootstrap",
        "--pipe-id",
        PIPE_ID,
        "--auth-key",
        &"ab".repeat(32),
        "--owner-sid",
        "S-1-5-21-1-2-3-1001",
    ];
    assert!(parse_bootstrap_args(&owned(&good)).is_ok());
    assert!(
        parse_bootstrap_args(&owned(&[&good[..], &["--role-desktop-boundary"]].concat())).is_ok()
    );
    let key = "ab".repeat(32);
    let short_key = "ab".repeat(31);
    let upper_id = PIPE_ID.to_ascii_uppercase();
    for broken in [
        vec![],
        good[..6].to_vec(),
        [&good[..], &["--extra"]].concat(),
        vec![
            "--pipe-id",
            PIPE_ID,
            "--tier",
            "bootstrap",
            "--auth-key",
            &key,
            "--owner-sid",
            "S-1-5-21-1-2-3-1001",
        ],
        replace(&good, 1, "Bootstrap"),
        replace(&good, 3, &upper_id),
        replace(&good, 3, "0123"),
        replace(&good, 3, "..\\..\\pipe"),
        replace(&good, 5, &short_key),
        replace(&good, 5, "zz"),
        replace(&good, 7, "not-a-sid"),
    ] {
        assert_eq!(
            parse_bootstrap_args(&owned(&broken))
                .expect_err("only the closed form is accepted")
                .kind(),
            io::ErrorKind::InvalidInput,
            "{broken:?}"
        );
    }
}

fn owned(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

fn replace<'a>(args: &[&'a str], index: usize, value: &'a str) -> Vec<&'a str> {
    let mut changed = args.to_vec();
    changed[index] = value;
    changed
}

/// The supervisor is today's tier runner, so its command line is the one the runner always had.
#[test]
fn the_supervisor_command_line_is_the_runner_s() {
    assert_eq!(
        runner_command_line(
            Path::new(r"C:\Program Files\SuperClaw\native_isolation_launcher.exe"),
            "bootstrap",
            "a1b2",
            &"ab".repeat(32),
        ),
        format!(
            "\"C:\\Program Files\\SuperClaw\\native_isolation_launcher.exe\" --tier-runner \
             --tier bootstrap --pipe-id a1b2 --auth-key {}",
            "ab".repeat(32)
        )
    );
}

#[test]
fn the_handoff_pipe_name_is_in_the_tier_namespace_and_refuses_a_hostile_id() {
    assert_eq!(
        handoff_pipe_name(PIPE_ID).expect("a launch id is a pipe id"),
        format!(r"\\.\pipe\SuperClawTierRunner-{PIPE_ID}-handoff")
    );
    for hostile in ["", "a/b", "a b", "..\\x", &"x".repeat(65)] {
        assert!(handoff_pipe_name(hostile).is_err(), "{hostile:?}");
    }
}

/// Every step has its own exit code, the codes round-trip, and none of them can be mistaken for the Job's
/// termination code or for the owner's release.
#[test]
fn each_bootstrap_step_exits_with_its_own_code() {
    let codes: Vec<u32> = BootstrapStep::ALL
        .iter()
        .map(|step| step.exit_code())
        .collect();
    let unique: HashSet<u32> = codes.iter().copied().collect();
    assert_eq!(unique.len(), codes.len());
    for step in BootstrapStep::ALL {
        assert_eq!(BootstrapStep::from_exit_code(step.exit_code()), Some(step));
        assert_ne!(step.exit_code(), JOB_EXIT_CODE);
        assert_ne!(step.exit_code(), BOOTSTRAP_RELEASED_EXIT_CODE);
        assert_ne!(step.exit_code(), 0);
        assert!(!step.describe().is_empty());
    }
    for unrelated in [
        0,
        1,
        101,
        JOB_EXIT_CODE,
        BOOTSTRAP_RELEASED_EXIT_CODE,
        0xC000_0142,
    ] {
        assert_eq!(
            BootstrapStep::from_exit_code(unrelated),
            None,
            "{unrelated:#x}"
        );
    }
}

//! Account password generation on top of the system RNG in `random_bytes.rs`.

use crate::random_bytes::fill_random;
use std::io;

const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER: &[u8] = b"abcdefghijkmnpqrstuvwxyz";
const DIGIT: &[u8] = b"23456789";
const SYMBOL: &[u8] = b"!@#$%^&*-_=+?";

/// Password length: comfortably above default Windows complexity minimums.
const PASSWORD_LEN: usize = 28;

/// Draws a uniformly random index in `0..bound` (`bound <= 256`) via rejection sampling, so the
/// modulo bias from `256 % bound` cannot skew the distribution.
fn random_index_below(bound: usize) -> io::Result<usize> {
    assert!(bound > 0 && bound <= 256, "bound must be in 1..=256");
    let limit = 256 - (256 % bound as u32);
    loop {
        let mut byte = [0u8; 1];
        fill_random(&mut byte)?;
        if (byte[0] as u32) < limit {
            return Ok(byte[0] as usize % bound);
        }
    }
}

fn random_char(charset: &[u8]) -> io::Result<u8> {
    Ok(charset[random_index_below(charset.len())?])
}

/// Generates a random password that deterministically satisfies typical Windows complexity
/// policy (at least one upper, lower, digit, and symbol character) rather than relying on
/// chance across a large charset.
pub fn generate_password() -> io::Result<String> {
    let mut chars = Vec::with_capacity(PASSWORD_LEN);
    chars.push(random_char(UPPER)?);
    chars.push(random_char(LOWER)?);
    chars.push(random_char(DIGIT)?);
    chars.push(random_char(SYMBOL)?);

    let combined: Vec<u8> = [UPPER, LOWER, DIGIT, SYMBOL].concat();
    for _ in chars.len()..PASSWORD_LEN {
        chars.push(random_char(&combined)?);
    }

    // Fisher-Yates shuffle so the guaranteed categories aren't always in the same positions.
    for i in (1..chars.len()).rev() {
        let j = random_index_below(i + 1)?;
        chars.swap(i, j);
    }

    // All characters above are ASCII by construction.
    Ok(String::from_utf8(chars).expect("password charset is ASCII"))
}

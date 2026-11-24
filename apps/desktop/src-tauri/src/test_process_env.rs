//! Serializes tests that mutate process-global environment variables.

use std::sync::Mutex;

pub static ENV_MUTEX: Mutex<()> = Mutex::new(());

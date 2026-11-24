//! Bounded overlapped byte movement over one end of a named pipe.
//!
//! This is the layer under every named-pipe conversation in this crate - the tier control and report
//! pipes in `launcher::pipe`, and the provision pipe in `provision_session::pipe`. It moves
//! length-prefixed frames and nothing else, and it does not know which pipe is which, who is on the
//! other end, or what a frame means. That is what lets two boundaries share it without sharing a
//! protocol: each brings its own frame budget, deadlines and authentication.
//!
//! # Why every wait is overlapped
//!
//! The peer on the other end is a separate process that can crash, hang, or be killed. With synchronous
//! I/O each of those becomes an unbounded block in whichever peer is waiting. Overlapped I/O with an
//! event and a deadline turns all of them into the same deterministic outcome: a `TimedOut` refusal at a
//! known upper bound. There are exactly two deliberate exceptions, and both are named where they occur:
//! the runner's wait for `Stop`, whose deadline is `None` because the role's lifetime is genuinely
//! unbounded and EOF rather than a clock is the signal, and the release wait in `cancel` below.
//!
//! # Why a cancelled operation can leave an endpoint unusable
//!
//! A cancelled read may already have taken bytes out of the pipe that the caller never received, and a
//! cancelled write may already have delivered part of a frame. Either way the next operation would start
//! at an offset nobody can name, so the endpoint records it and refuses to be used again rather than
//! reading a frame length out of the middle of somebody's JSON. Every caller in this crate tears the
//! launch down on a timeout anyway, but that is the caller's discipline and this is the transport's own
//! property.

use crate::frame::{FRAME_PREFIX_BYTES, declared_frame_len};
use crate::process_win32::OwnedHandle;
use std::cell::Cell;
use std::io;
use std::time::Instant;
use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_PIPE_NOT_CONNECTED, GetLastError,
    WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Threading::{
    CreateEventW, INFINITE, ResetEvent, WaitForSingleObject,
};

/// How long a cancelled operation is given to be acknowledged before the release wait below stops being
/// bounded. This is not a policy budget: it exists only so the common case cannot block for long.
const CANCEL_ACKNOWLEDGE_TIMEOUT_MS: u32 = 5_000;

/// One end of a named pipe, with the event its overlapped operations complete on.
///
/// The event is per-endpoint rather than per-operation because an endpoint has exactly one operation
/// outstanding at a time: `OwnedHandle` is `Send` but not `Sync`, so no two threads can hold this by
/// reference at once, and every conversation built on it is strictly alternating - the one-way tier pipes
/// because each carries traffic in a single direction, the duplex provision pipe because one side writes
/// a request and only then reads a response. A caller that issued a read and a write on the same endpoint
/// concurrently would have them share this event and complete each other's waits, so no caller does.
pub(crate) struct Endpoint {
    handle: OwnedHandle,
    event: OwnedHandle,
    /// Set when an operation ended with bytes unaccounted for, which makes every later frame boundary on
    /// this endpoint a guess. Once set it is never cleared: there is no way to resynchronize a byte-mode
    /// pipe, because the bytes that were lost are exactly the ones that would say where the next frame
    /// begins.
    desynchronized: Cell<bool>,
}

impl Endpoint {
    pub(crate) fn adopt(handle: OwnedHandle) -> io::Result<Self> {
        // SAFETY: A manual-reset, initially non-signaled, unnamed event with default security.
        let event =
            OwnedHandle::new(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })?;
        Ok(Self {
            handle,
            event,
            desynchronized: Cell::new(false),
        })
    }

    pub(crate) fn raw(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.handle.raw()
    }

    /// Prepares a fresh `OVERLAPPED` for one operation. The event is reset explicitly rather than
    /// relying on the I/O call to do it, so a stale signal from a previous cancelled operation cannot
    /// be mistaken for this one completing.
    pub(crate) fn arm(&self) -> io::Result<OVERLAPPED> {
        // SAFETY: The event handle is a valid manual-reset event this process owns.
        if unsafe { ResetEvent(self.event.raw()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: An all-zero OVERLAPPED is the documented starting state for a non-file operation.
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = self.event.raw();
        Ok(overlapped)
    }

    /// Waits for one armed operation to finish and reports how many bytes moved.
    ///
    /// On timeout the operation is cancelled and the cancellation is waited for before returning,
    /// because the kernel owns the `OVERLAPPED` until then and it lives on the caller's stack. If the
    /// cancellation moved bytes, the endpoint is marked desynchronized: those bytes are gone from the
    /// pipe and nobody has them.
    pub(crate) fn finish(
        &self,
        overlapped: &mut OVERLAPPED,
        started: i32,
        deadline: Option<Instant>,
        what: &str,
    ) -> io::Result<u32> {
        if started == 0 {
            // SAFETY: GetLastError immediately follows the call that returned zero.
            let code = unsafe { GetLastError() };
            if code != ERROR_IO_PENDING {
                return Err(io::Error::from_raw_os_error(code as i32));
            }
            // SAFETY: The event belongs to the pending operation and the timeout is a valid duration.
            let waited =
                unsafe { WaitForSingleObject(self.event.raw(), remaining_millis(deadline)) };
            if waited != WAIT_OBJECT_0 {
                let moved = self.cancel(overlapped);
                if moved > 0 {
                    self.desynchronize();
                }
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "the pipe {what} did not complete within its deadline, after {moved} \
                         byte(s)"
                    ),
                ));
            }
        }
        let mut transferred = 0;
        // SAFETY: The operation is complete, so the OVERLAPPED and the byte count are readable.
        if unsafe { GetOverlappedResult(self.handle.raw(), overlapped, &mut transferred, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(transferred)
    }

    /// Cancels a pending operation, waits for the kernel to release it, and reports how many bytes it
    /// moved anyway.
    ///
    /// The last wait here is deliberately unbounded, and the 5 s wait above it is a courtesy rather than
    /// the guarantee: until the kernel releases a cancelled operation it may still write to both the
    /// `OVERLAPPED` and the caller's buffer, and both live on the caller's stack. Returning early would
    /// therefore be a use-after-free of memory the kernel still holds, which is strictly worse than
    /// waiting. `CancelIoEx` on a named pipe is completed by NPFS without needing the peer to do
    /// anything, so the wait has no dependency on the process at the other end.
    fn cancel(&self, overlapped: &mut OVERLAPPED) -> u32 {
        let mut transferred = 0;
        // SAFETY: Both handles are valid and the OVERLAPPED is the one the pending operation was issued
        // with. Waiting for the release is what makes it sound to pop this frame afterwards.
        unsafe {
            CancelIoEx(self.handle.raw(), overlapped);
            WaitForSingleObject(self.event.raw(), CANCEL_ACKNOWLEDGE_TIMEOUT_MS);
            GetOverlappedResult(self.handle.raw(), overlapped, &mut transferred, 1);
        }
        transferred
    }

    /// Records that this endpoint's frame boundaries are no longer known.
    fn desynchronize(&self) {
        self.desynchronized.set(true);
    }

    /// Refuses an operation on an endpoint whose frame boundaries were lost.
    fn check_synchronized(&self) -> io::Result<()> {
        if self.desynchronized.get() {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "a cancelled operation left this pipe mid-frame, so it carries no further frames",
            ));
        }
        Ok(())
    }

    /// Reads until `buffer` is full or the peer is gone, returning how many bytes were read. A short
    /// result is the caller's to interpret: at a frame boundary it is EOF, mid-frame it is truncation.
    fn read_up_to(&self, buffer: &mut [u8], deadline: Option<Instant>) -> io::Result<usize> {
        let mut offset = 0;
        while offset < buffer.len() {
            let mut overlapped = self.arm()?;
            let remaining = (buffer.len() - offset) as u32;
            // SAFETY: The handle is an overlapped readable pipe end, the destination slice is
            // writable for `remaining` bytes, and the OVERLAPPED outlives the operation because
            // `finish` either completes or cancels it before returning.
            let started = unsafe {
                ReadFile(
                    self.handle.raw(),
                    buffer[offset..].as_mut_ptr(),
                    remaining,
                    std::ptr::null_mut(),
                    &mut overlapped,
                )
            };
            match self.finish(&mut overlapped, started, deadline, "read") {
                Ok(0) => return Ok(offset),
                Ok(read) => offset += read as usize,
                Err(error) if peer_is_gone(&error) => return Ok(offset),
                Err(error) => {
                    if offset > 0 {
                        // Bytes already left the pipe and this call is the only thing that had them.
                        self.desynchronize();
                    }
                    return Err(error);
                }
            }
        }
        Ok(offset)
    }

    fn write_all(&self, buffer: &[u8], deadline: Option<Instant>) -> io::Result<()> {
        let mut offset = 0;
        while offset < buffer.len() {
            let mut overlapped = self.arm()?;
            let remaining = (buffer.len() - offset) as u32;
            // SAFETY: The handle is an overlapped writable pipe end, the source slice is readable for
            // `remaining` bytes, and `finish` completes or cancels before this frame is popped.
            let started = unsafe {
                WriteFile(
                    self.handle.raw(),
                    buffer[offset..].as_ptr(),
                    remaining,
                    std::ptr::null_mut(),
                    &mut overlapped,
                )
            };
            let written = match self.finish(&mut overlapped, started, deadline, "write") {
                Ok(written) => written,
                Err(error) => {
                    if offset > 0 {
                        // Part of this frame is already at the peer, which cannot be taken back.
                        self.desynchronize();
                    }
                    return Err(error);
                }
            };
            if written == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "the pipe accepted zero bytes",
                ));
            }
            offset += written as usize;
        }
        Ok(())
    }

    /// Reads one length-prefixed frame body, or `None` if the peer closed at a frame boundary.
    ///
    /// `max_frame_bytes` is the caller's budget rather than a constant of this module, for the reason
    /// given in `frame.rs`: each boundary has its own, and a shared one would have to be wrong for one
    /// of them.
    pub(crate) fn read_frame(
        &self,
        max_frame_bytes: usize,
        deadline: Option<Instant>,
    ) -> io::Result<Option<Vec<u8>>> {
        self.check_synchronized()?;
        let mut prefix = [0u8; FRAME_PREFIX_BYTES];
        let read = self.read_up_to(&mut prefix, deadline)?;
        if read == 0 {
            return Ok(None);
        }
        if read < prefix.len() {
            self.desynchronize();
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "the pipe closed inside a frame length prefix",
            ));
        }
        let length = declared_frame_len(prefix, max_frame_bytes).map_err(|error| {
            // The prefix is consumed and the body is still in the pipe, so this endpoint cannot be
            // resumed even though the refusal itself is clean.
            self.desynchronize();
            io::Error::new(io::ErrorKind::InvalidData, error.code())
        })?;
        let mut body = vec![0u8; length];
        // Anything short of the whole body leaves the stream inside a frame, so the failure is the
        // endpoint's and not only this call's.
        match self.read_up_to(&mut body, deadline) {
            Ok(read) if read == length => Ok(Some(body)),
            Ok(_) => {
                self.desynchronize();
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "the pipe closed inside a frame body",
                ))
            }
            Err(error) => {
                self.desynchronize();
                Err(error)
            }
        }
    }

    /// Writes bytes with no framing at all, so a test can produce a frame the transport would never
    /// produce - a bare prefix, or a body cut short - and check what the reader does with it.
    #[cfg(test)]
    pub(crate) fn write_unframed(&self, bytes: &[u8], deadline: Option<Instant>) -> io::Result<()> {
        self.write_all(bytes, deadline)
    }

    pub(crate) fn write_frame(
        &self,
        body: &[u8],
        max_frame_bytes: usize,
        deadline: Option<Instant>,
    ) -> io::Result<()> {
        self.check_synchronized()?;
        if body.is_empty() || body.len() > max_frame_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "a frame body must be 1..={max_frame_bytes} bytes, not {}",
                    body.len()
                ),
            ));
        }
        let mut framed = Vec::with_capacity(FRAME_PREFIX_BYTES + body.len());
        framed.extend_from_slice(&(body.len() as u32).to_le_bytes());
        framed.extend_from_slice(body);
        self.write_all(&framed, deadline)
    }
}

fn remaining_millis(deadline: Option<Instant>) -> u32 {
    match deadline {
        None => INFINITE,
        Some(at) => {
            let remaining = at.saturating_duration_since(Instant::now()).as_millis();
            // Clamped below INFINITE so a very distant deadline cannot accidentally mean "forever".
            remaining.min(u128::from(u32::MAX - 1)) as u32
        }
    }
}

/// Whether an error means the other end is gone, which at a frame boundary is EOF rather than a fault.
fn peer_is_gone(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(code)
            if code == ERROR_BROKEN_PIPE as i32
                || code == ERROR_PIPE_NOT_CONNECTED as i32
                || code == ERROR_NO_DATA as i32
    )
}

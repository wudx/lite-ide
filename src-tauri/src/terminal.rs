//! Interactive terminal (PTY) sessions for opened projects.
//!
//! One session owns a ConPTY (Windows) / unix PTY pair plus the spawned
//! shell process. Output is streamed to the frontend through a
//! `tauri::ipc::Channel` sink as base64 data frames (byte boundaries are
//! never split mid-UTF-8 because frames carry raw bytes), and the exit code
//! is delivered as a final event. The shell always starts in the project's
//! canonical root, which the command layer resolves from the project id —
//! client input never supplies a filesystem path.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine;
use dashmap::DashMap;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use uuid::Uuid;

use crate::error::AppError;

/// One streamed frame towards the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TerminalEvent {
    Data { base64: String },
    Exit { code: i32 },
}

/// Backend-agnostic output sink so tests can collect events without Tauri.
pub trait TerminalSink: Send + Sync + 'static {
    fn emit(&self, event: TerminalEvent) -> Result<(), String>;
}

impl TerminalSink for Channel<TerminalEvent> {
    fn emit(&self, event: TerminalEvent) -> Result<(), String> {
        self.send(event).map_err(|err| err.to_string())
    }
}

/// Result of a successful spawn, mirrored by the TS `TerminalSessionHandle`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpawned {
    pub session_id: String,
    pub shell_label: String,
}

struct TerminalSession {
    /// PTY input side, shared with the pump thread which answers terminal
    /// queries (DSR) that ConPTY blocks on until a "terminal" responds.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send>>>,
    /// Held until the child exits; the reaper drops it (Some → None) to
    /// surface an EOF on the pump reader. Optional so it can be released
    /// without `&mut self`.
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    /// Exit code stashed by the reaper; None until the child is reaped.
    exit_code: Arc<Mutex<Option<i32>>>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: DashMap<String, Arc<TerminalSession>>,
}

/// Selects the default shell: `pwsh` → `powershell` → `ComSpec` on Windows,
/// `$SHELL` → `bash` → `sh` elsewhere. Returns `(program, display_label)`.
pub fn default_shell() -> (String, String) {
    #[cfg(windows)]
    {
        for (program, label) in [("pwsh.exe", "pwsh"), ("powershell.exe", "powershell")] {
            if which_program(program) {
                return (program.to_string(), label.to_string());
            }
        }
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        (comspec, "cmd".to_string())
    }
    #[cfg(not(windows))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if !shell.trim().is_empty() {
                let label = std::path::Path::new(&shell)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| shell.clone());
                return (shell, label);
            }
        }
        if which_program("bash") {
            return ("/bin/bash".to_string(), "bash".to_string());
        }
        ("/bin/sh".to_string(), "sh".to_string())
    }
}

/// Checks `PATH` for an executable without spawning a process.
fn which_program(program: &str) -> bool {
    let path_env = match std::env::var("PATH") {
        Ok(value) => value,
        Err(_) => return false,
    };
    #[cfg(windows)]
    let exe = if program.to_ascii_lowercase().ends_with(".exe") {
        program.to_string()
    } else {
        format!("{program}.exe")
    };
    #[cfg(not(windows))]
    let exe = program.to_string();

    std::env::split_paths(&path_env).any(|dir| {
        let candidate = dir.join(&exe);
        candidate.is_file()
    })
}

fn build_default_command(root: &Path) -> (CommandBuilder, String) {
    let (program, label) = default_shell();
    let mut cmd = CommandBuilder::new(program);
    // canonicalize 在 Windows 上产生 `\\?\` 前缀，交给 shell 前剥掉，
    // 否则 PowerShell 会把工作目录显示为 `Microsoft.PowerShell.Core\FileSystem::\\?\...`。
    let plain_cwd = crate::project::strip_verbatim_prefix(root);
    cmd.cwd(plain_cwd);
    (cmd, label)
}

impl TerminalManager {
    pub fn kill_all(&self) {
        for entry in self.sessions.iter() {
            if let Ok(mut child) = entry.value().child.lock() {
                let _ = child.kill();
            }
        }
        self.sessions.clear();
    }
}

/// Spawns the project shell inside a fresh PTY and starts the output pump.
pub fn spawn(
    manager: &Arc<TerminalManager>,
    root: &Path,
    cols: u16,
    rows: u16,
    sink: Arc<dyn TerminalSink>,
) -> Result<TerminalSpawned, AppError> {
    if !root.is_dir() {
        return Err(AppError::ProjectNotFound(root.display().to_string()));
    }
    let (cmd, label) = build_default_command(root);
    spawn_with_command(manager, cols, rows, cmd, label, sink)
}

/// Core spawn used by both the default shell path and tests. The manager is
/// shared with the reaper thread so reaped sessions are forgotten immediately
/// instead of lingering until app exit.
pub fn spawn_with_command(
    manager: &Arc<TerminalManager>,
    cols: u16,
    rows: u16,
    cmd: CommandBuilder,
    shell_label: String,
    sink: Arc<dyn TerminalSink>,
) -> Result<TerminalSpawned, AppError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| AppError::Terminal(format!("openpty failed: {err}")))?;

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| AppError::Terminal(format!("failed to spawn shell: {err}")))?;
    // From here on the child exists: any setup failure must kill it explicitly
    // instead of relying on the dropped master handle to reap it eventually.
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(err) => {
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Terminal(format!("failed to take pty writer: {err}")));
        }
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(err) => {
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Terminal(format!(
                "failed to clone pty reader: {err}"
            )));
        }
    };

    let session_id = Uuid::new_v4().to_string();
    let writer = Arc::new(Mutex::new(writer));
    let session = Arc::new(TerminalSession {
        writer: Arc::clone(&writer),
        child: Arc::new(Mutex::new(child)),
        master: Arc::new(Mutex::new(Some(pair.master))),
        exit_code: Arc::new(Mutex::new(None)),
    });
    manager
        .sessions
        .insert(session_id.clone(), Arc::clone(&session));

    // Drop our slave handle so reader EOF maps to the child exiting.
    drop(pair.slave);

    // Reaper: polls the child, then closes the ConPTY so the pump reader
    // unblocks with EOF and the exit event can carry the real exit code.
    {
        let manager_for_reaper = Arc::clone(manager);
        let session_id_for_reaper = session_id.clone();
        let child = Arc::clone(&session.child);
        let master_slot = Arc::clone(&session.master);
        let exit_slot = Arc::clone(&session.exit_code);
        thread::spawn(move || {
            let mut code = -1i32;
            loop {
                let reaped = {
                    let Ok(mut guard) = child.lock() else {
                        break;
                    };
                    match guard.try_wait() {
                        Ok(Some(status)) => {
                            code = status.exit_code() as i32;
                            true
                        }
                        Ok(None) => false,
                        Err(_) => true,
                    }
                };
                if reaped {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            if let Ok(mut slot) = exit_slot.lock() {
                *slot = Some(code);
            }
            // Closing (dropping) the master unblocks the pump with EOF.
            if let Ok(mut master) = master_slot.lock() {
                *master = None;
            }
            // Forget the dead session right away; the map entry would
            // otherwise linger until app exit.
            manager_for_reaper.sessions.remove(&session_id_for_reaper);
        });
    }

    let exit_slot_for_pump = Arc::clone(&session.exit_code);
    thread::spawn(move || {
        pump_output(reader, writer, Arc::clone(&sink));

        // EOF reached (or the pump stopped): the reaper has already stashed
        // the exit code by the time the master closes; wait briefly for it.
        let mut code = -1i32;
        for _ in 0..100 {
            if let Ok(slot) = exit_slot_for_pump.lock() {
                if let Some(value) = *slot {
                    code = value;
                    break;
                }
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = sink.emit(TerminalEvent::Exit { code });
    });

    Ok(TerminalSpawned {
        session_id,
        shell_label: shell_label,
    })
}

/// Blocking read loop: PTY bytes → base64 data frames on the sink. Also acts
/// as the minimal "terminal" side of the wire: ConPTY probes the emulator
/// with a DSR cursor-position query (`ESC[6n`) and stalls until it gets a
/// reply, so the pump answers from the input stream on the shell's behalf and
/// strips the query from the forwarded stream (xterm.js would otherwise
/// answer a second time).
fn pump_output(
    mut reader: Box<dyn Read + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    sink: Arc<dyn TerminalSink>,
) {
    let mut buf = [0u8; 8192];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                // A trailing partial query prefix is ordinary output, forward it.
                if !carry.is_empty() {
                    let bytes = std::mem::take(&mut carry);
                    let base64 = BASE64_ENGINE.encode(&bytes);
                    if sink.emit(TerminalEvent::Data { base64 }).is_err() {
                        break;
                    }
                }
                break;
            }
            Ok(n) => {
                let (cleaned, queries) = strip_dsr_queries(&buf[..n], &mut carry);
                for _ in 0..queries {
                    // Report the cursor at home position; ConPTY only needs a
                    // well-formed reply to keep the shell moving.
                    if let Ok(mut input) = writer.lock() {
                        let _ = input.write_all(b"\x1b[1;1R").and_then(|_| input.flush());
                    }
                }
                if !cleaned.is_empty() {
                    let base64 = BASE64_ENGINE.encode(&cleaned);
                    if sink.emit(TerminalEvent::Data { base64 }).is_err() {
                        // Frontend went away; stop pumping.
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
}

/// Removes every DSR query from `input` (joined with `carry` from the previous
/// chunk so queries split across reads are still caught), replying info via
/// `queries_removed`. A trailing partial query prefix is parked back into
/// `carry` for the next chunk.
fn strip_dsr_queries(input: &[u8], carry: &mut Vec<u8>) -> (Vec<u8>, usize) {
    const DSR: &[u8] = b"\x1b[6n";

    let mut data = std::mem::take(carry);
    data.extend_from_slice(input);

    let mut out = Vec::with_capacity(data.len());
    let mut removed = 0usize;
    let mut rest = data.as_slice();
    while let Some(pos) = find_subslice(rest, DSR) {
        out.extend_from_slice(&rest[..pos]);
        rest = &rest[pos + DSR.len()..];
        removed += 1;
    }

    // Park a trailing partial query prefix (e.g. "\x1b[6") for the next read.
    let keep = (1..DSR.len())
        .rev()
        .find(|len| rest.len() >= *len && rest[rest.len() - len..] == DSR[..*len])
        .unwrap_or(0);
    carry.extend_from_slice(&rest[rest.len() - keep..]);
    out.extend_from_slice(&rest[..rest.len() - keep]);
    (out, removed)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

pub fn write(manager: &TerminalManager, session_id: &str, data: &str) -> Result<(), AppError> {
    let session = manager
        .sessions
        .get(session_id)
        .ok_or_else(|| AppError::Terminal(format!("terminal session not found: {session_id}")))?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| AppError::Terminal("terminal writer poisoned".to_string()))?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|err| AppError::Terminal(format!("terminal write failed: {err}")))?;
    Ok(())
}

pub fn resize(manager: &TerminalManager, session_id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
    let session = manager
        .sessions
        .get(session_id)
        .ok_or_else(|| AppError::Terminal(format!("terminal session not found: {session_id}")))?;
    let master = session
        .master
        .lock()
        .map_err(|_| AppError::Terminal("terminal master poisoned".to_string()))?;
    match master.as_ref() {
        Some(master) => master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| AppError::Terminal(format!("terminal resize failed: {err}")))?,
        // Session already closing; the frontend will observe the exit event.
        None => {}
    }
    Ok(())
}

/// Kills the session (process + PTY) and forgets it. Idempotent.
pub fn kill(manager: &TerminalManager, session_id: &str) -> Result<(), AppError> {
    let Some((_, session)) = manager.sessions.remove(session_id) else {
        return Ok(());
    };
    if let Ok(mut child) = session.child.lock() {
        let _ = child.kill();
    }
    // Release the ConPTY promptly so the pump reader unblocks and the exit
    // event reaches the frontend without waiting on the reaper.
    if let Ok(mut master) = session.master.lock() {
        *master = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct CollectSink {
        tx: mpsc::SyncSender<TerminalEvent>,
    }

    impl TerminalSink for CollectSink {
        fn emit(&self, event: TerminalEvent) -> Result<(), String> {
            self.tx.send(event).map_err(|err| err.to_string())
        }
    }

    fn collect_events(
        rx: mpsc::Receiver<TerminalEvent>,
        timeout: Duration,
    ) -> Vec<TerminalEvent> {
        let deadline = std::time::Instant::now() + timeout;
        let mut events = Vec::new();
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(event) => events.push(event),
                Err(mpsc::TryRecvError::Empty) => thread::sleep(Duration::from_millis(10)),
                Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }
        events
    }

    fn decoded_text(events: &[TerminalEvent]) -> String {
        let mut text = String::new();
        for event in events {
            if let TerminalEvent::Data { base64 } = event {
                let bytes = BASE64_ENGINE.decode(base64).unwrap_or_default();
                text.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        text
    }

    #[test]
    fn default_shell_selects_an_existing_program() {
        let (program, label) = default_shell();
        assert!(!program.is_empty());
        assert!(!label.is_empty());
        #[cfg(windows)]
        assert!(program.to_ascii_lowercase().ends_with(".exe"));
        #[cfg(not(windows))]
        assert!(program.starts_with('/'));
    }

    #[test]
    fn strip_dsr_removes_queries_and_handles_split_chunks() {
        let mut carry = Vec::new();
        let (out, removed) = strip_dsr_queries(b"hello\x1b[6nworld", &mut carry);
        assert_eq!(out, b"helloworld");
        assert_eq!(removed, 1);
        assert!(carry.is_empty());

        // Query split across two reads is still caught via the carry buffer.
        let mut carry = Vec::new();
        let (out, removed) = strip_dsr_queries(b"abc\x1b[", &mut carry);
        assert_eq!(out, b"abc");
        assert_eq!(removed, 0);
        let (out, removed) = strip_dsr_queries(b"6nxyz", &mut carry);
        assert_eq!(out, b"xyz");
        assert_eq!(removed, 1);
        assert!(carry.is_empty());

        // Multiple queries in one chunk, each counted for a reply.
        let mut carry = Vec::new();
        let (out, removed) = strip_dsr_queries(b"\x1b[6nA\x1b[6nB", &mut carry);
        assert_eq!(out, b"AB");
        assert_eq!(removed, 2);

        // Trailing partial prefix parks in carry, completes on the next chunk.
        let mut carry = Vec::new();
        let (out, removed) = strip_dsr_queries(b"tail\x1b[6", &mut carry);
        assert_eq!(out, b"tail");
        assert_eq!(removed, 0);
        assert_eq!(carry, b"\x1b[6");
        let (out, removed) = strip_dsr_queries(b"n!", &mut carry);
        assert_eq!(out, b"!");
        assert_eq!(removed, 1);
    }

    #[test]
    fn spawn_writes_reach_the_pty_and_exit_is_reported() {
        let manager = std::sync::Arc::new(TerminalManager::default());

        let (tx, rx) = mpsc::sync_channel::<TerminalEvent>(1024);
        let sink: Arc<dyn TerminalSink> = Arc::new(CollectSink { tx });

        // A short-lived shell that echoes a marker then exits cleanly. Pinned
        // to cmd.exe explicitly: the default shell may be powershell/pwsh,
        // which does not understand cmd's /C argument style.
        #[cfg(windows)]
        let mut cmd = CommandBuilder::new("cmd.exe");
        #[cfg(windows)]
        cmd.args(["/C", "echo terminal-e2e-marker"]);
        #[cfg(not(windows))]
        let mut cmd = CommandBuilder::new("sh");
        #[cfg(not(windows))]
        cmd.args(["-c", "echo terminal-e2e-marker"]);

        let spawned = spawn_with_command(&manager, 80, 24, cmd, "test".into(), sink)
            .expect("spawn should succeed");
        assert!(!spawned.session_id.is_empty());

        let events = collect_events(rx, Duration::from_secs(15));
        let text = decoded_text(&events);
        assert!(
            text.contains("terminal-e2e-marker"),
            "expected marker in PTY output, got: {text:?}"
        );
        assert!(
            events
                .iter()
                .any(|event| matches!(event, TerminalEvent::Exit { code: 0 })),
            "expected a clean exit event, got: {events:?}"
        );

        // The session cleans up after its child exits on its own.
        kill(&manager, &spawned.session_id).unwrap();
    }

    #[test]
    fn write_after_kill_is_an_error_and_kill_is_idempotent() {
        let manager = std::sync::Arc::new(TerminalManager::default());

        let (tx, _rx) = mpsc::sync_channel::<TerminalEvent>(1024);
        let sink: Arc<dyn TerminalSink> = Arc::new(CollectSink { tx });

        // Long-lived shell for the kill path; lifetime does not matter here
        // because the test kills the session first.
        #[cfg(windows)]
        let mut cmd = CommandBuilder::new("cmd.exe");
        #[cfg(windows)]
        cmd.args(["/K", "echo alive"]);
        #[cfg(not(windows))]
        let mut cmd = CommandBuilder::new("sh");
        #[cfg(not(windows))]
        cmd.args(["-c", "cat"]);

        let spawned =
            spawn_with_command(&manager, 80, 24, cmd, "test".into(), sink).unwrap();

        kill(&manager, &spawned.session_id).unwrap();
        assert!(kill(&manager, &spawned.session_id).is_ok());
        let err = write(&manager, &spawned.session_id, "x").unwrap_err();
        assert!(matches!(err, AppError::Terminal(_)));
    }

    #[test]
    fn build_default_command_strips_windows_verbatim_prefix() {
        let (cmd, _label) = build_default_command(Path::new(r"\\?\E:\ProjectsCocos\Arrow-Cube-fengling"));
        assert_eq!(
            cmd.get_cwd().and_then(|p| p.to_str()),
            Some(r"E:\ProjectsCocos\Arrow-Cube-fengling")
        );
    }
}

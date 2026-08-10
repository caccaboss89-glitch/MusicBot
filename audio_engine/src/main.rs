//! Entry point: wires stdin (JSON commands from Node.js) to the mixer thread.

mod config;
mod deck;
mod download;
mod mixer;
mod protocol;

use crossbeam_channel::bounded;
#[cfg(unix)]
use libc;
use std::io;
use std::thread;

use crate::mixer::mixer_loop;
use crate::protocol::{send_log, InputCommand};

fn main() {
    // Prevents Rust process from terminating on SIGPIPE when Node closes pipe
    // (Unix only - Windows doesn't have SIGPIPE)
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    // Installs global panic hook: if mixer_loop panics (e.g. division by zero,
    // unwrap on None, OOM), the hook writes an error event to stderr and terminates
    // process with code 1. This ensures Node.js receives exit code and starts
    // crash recovery, instead of leaving the process alive-but-silent.
    std::panic::set_hook(Box::new(|info| {
        let msg = info.to_string();
        send_log("error", &format!("PANIC in mixer thread: {}", msg));
        std::process::exit(1);
    }));

    let (tx, rx) = bounded::<InputCommand>(10);

    // Audio thread (Priority)
    thread::spawn(move || mixer_loop(rx));

    // Input JSON thread (Node -> Rust)
    let stdin = io::stdin();
    let iterator = serde_json::Deserializer::from_reader(stdin).into_iter::<InputCommand>();
    for item in iterator {
        if let Ok(cmd) = item {
            let _ = tx.send(cmd);
        }
    }
}

pub(super) enum SessionCmd {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}

#[cfg(target_os = "macos")]
mod openssh;
#[cfg(target_os = "macos")]
pub use openssh::{connect_openssh, connect_openssh_test, SshSession};

#[cfg(not(target_os = "macos"))]
mod russh_session;
#[cfg(not(target_os = "macos"))]
pub use russh_session::SshSession;

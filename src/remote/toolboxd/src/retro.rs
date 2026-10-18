use crate::{answer, log};
use std::fs::{self, File};
use std::os::unix::io::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;

pub fn send_fd(stream: &mut UnixStream, fd: RawFd, what: &str) {
    let mut text = *b"ok\n";
    let mut iov = libc::iovec { iov_base: text.as_mut_ptr() as *mut libc::c_void, iov_len: text.len() };
    let mut control = [0u8; 64];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = unsafe { libc::CMSG_SPACE(std::mem::size_of::<RawFd>() as u32) } as _;
    unsafe {
        let c = libc::CMSG_FIRSTHDR(&msg);
        (*c).cmsg_level = libc::SOL_SOCKET;
        (*c).cmsg_type = libc::SCM_RIGHTS;
        (*c).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<RawFd>() as u32) as _;
        *(libc::CMSG_DATA(c) as *mut RawFd) = fd;
        if libc::sendmsg(stream.as_raw_fd(), &msg, 0) < 0 {
            log(&format!("{}: {}", what, std::io::Error::last_os_error()));
        }
    }
}

pub fn keypad(stream: &mut UnixStream) {
    let device = fs::read_dir("/sys/class/input").ok().and_then(|dir| {
        dir.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).find(|name| {
            name.starts_with("event")
                && fs::read_to_string(format!("/sys/class/input/{}/device/name", name))
                .map_or(false, |n| n.trim().ends_with("matrix_keypad0"))
        })
    });
    match device.map(|d| File::open(format!("/dev/input/{}", d))) {
        Some(Ok(file)) => send_fd(stream, file.as_raw_fd(), "keypad"),
        Some(Err(e)) => answer(stream, false, format!("keypad: {}\n", e).as_bytes()),
        None => answer(stream, false, b"No keypad\n"),
    }
}

pub fn command(stream: &mut UnixStream, line: &str) {
    match line {
        "keypad" => keypad(stream),
        _ => answer(stream, false, b"Not a command\n"),
    }
}

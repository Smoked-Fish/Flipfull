use std::fs::File;
use std::io::{ErrorKind, Read};
use std::os::unix::io::AsRawFd;

const EV_KEY: u16 = 1;
const CODES: usize = 0x300;
// input_event on aarch64: timeval, type, code, value
const EVENT: usize = 24;

pub struct Keypad {
    file: File,
    held: Vec<bool>,
}

impl Keypad {
    pub fn open() -> Result<Keypad, String> {
        let file = flipfull_remote::keypad()?;
        unsafe {
            let fd = file.as_raw_fd();
            libc::fcntl(fd, libc::F_SETFL, libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK);
        }
        Ok(Keypad { file, held: vec![false; CODES] })
    }

    pub fn read(&mut self) {
        let mut buf = [0u8; EVENT * 64];
        loop {
            let n = match self.file.read(&mut buf) {
                Ok(n) if n >= EVENT => n,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                _ => return,
            };
            for e in buf[..n].chunks_exact(EVENT) {
                let kind = u16::from_ne_bytes([e[16], e[17]]);
                let code = u16::from_ne_bytes([e[18], e[19]]) as usize;
                let value = i32::from_ne_bytes([e[20], e[21], e[22], e[23]]);
                // 2 is a repeat
                if kind == EV_KEY && code < CODES && value != 2 {
                    self.held[code] = value == 1;
                }
            }
        }
    }

    pub fn held(&self, code: u16) -> bool {
        let c = code as usize;
        c < CODES && self.held[c]
    }
}

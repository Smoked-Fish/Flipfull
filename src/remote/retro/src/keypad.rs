use std::fs::File;
use std::io::{ErrorKind, Read};
use std::os::unix::io::AsRawFd;
use std::time::Duration;
use toolbox::Request;

const EV_SYN: u16 = 0;
const EV_KEY: u16 = 1;
const SYN_DROPPED: u16 = 3;
const CODES: usize = 0x300;
// input_event on aarch64: timeval, type, code, value
const EVENT: usize = 24;
const EVIOCGKEY: u64 = (2 << 30) | (((CODES / 8) as u64) << 16) | ((b'E' as u64) << 8) | 0x18;

pub struct Keypad {
    file: File,
    held: Vec<bool>,
    stale: Vec<bool>,
}

fn held(file: &File) -> Vec<bool> {
    let mut bits = [0u8; CODES / 8];
    unsafe { libc::ioctl(file.as_raw_fd(), EVIOCGKEY as _, bits.as_mut_ptr()) };
    (0..CODES).map(|c| bits[c / 8] & (1 << (c % 8)) != 0).collect()
}

impl Keypad {
    pub fn open() -> Result<Keypad, String> {
        let file = flipfull_remote::ask(&Request::Keypad, Some(Duration::from_secs(10)))?.file()?;
        unsafe {
            let fd = file.as_raw_fd();
            libc::fcntl(fd, libc::F_SETFL, libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK);
        }
        let held = held(&file);
        Ok(Keypad { stale: held.clone(), held, file })
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
                if kind == EV_SYN && code == SYN_DROPPED as usize {
                    // buffer overran, ask what's held
                    self.held = held(&self.file);
                    for (s, h) in self.stale.iter_mut().zip(&self.held) {
                        *s = *s && *h;
                    }
                } else if kind == EV_KEY && code < CODES && value != 2 {
                    // 2 is a repeat
                    self.held[code] = value == 1;
                    if value == 0 {
                        self.stale[code] = false;
                    }
                }
            }
        }
    }

    pub fn held(&self, code: u16) -> bool {
        let c = code as usize;
        c < CODES && self.held[c] && !self.stale[c]
    }
}

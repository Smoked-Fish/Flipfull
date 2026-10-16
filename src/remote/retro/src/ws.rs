use std::io::{self, Read, Write};
use std::net::TcpStream;

const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_REQUEST: usize = 8192;
const MAX_MESSAGE: u64 = 64 * 1024;

pub const TEXT: u8 = 1;
pub const BINARY: u8 = 2;
const CLOSE: u8 = 8;
const PING: u8 = 9;
const PONG: u8 = 10;

pub const HEADER: usize = 10;

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5a827999),
                20..=39 => (b ^ c ^ d, 0x6ed9eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc),
                _ => (b ^ c ^ d, 0xca62c1d6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 20];
    for (i, x) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&x.to_be_bytes());
    }
    out
}

fn base64(data: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { ABC[(n >> (18 - 6 * i)) as usize & 63] as char } else { '=' });
        }
    }
    out
}

pub struct Request {
    pub path: String,
    pub origin: Option<String>,
    pub key: Option<String>,
}

pub fn request(stream: &mut TcpStream) -> io::Result<Request> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_REQUEST || stream.read(&mut byte)? == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "no request"));
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head);
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or("");
    let path = match first.strip_prefix("GET ").and_then(|r| r.strip_suffix(" HTTP/1.1")) {
        Some(p) => p.to_string(),
        None => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("not a GET: {:?}", first))),
    };
    let mut request = Request { path, origin: None, key: None };
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "sec-websocket-key" => request.key = Some(value.trim().to_string()),
                "origin" => request.origin = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    Ok(request)
}

pub fn upgrade(stream: &mut TcpStream, key: &str) -> io::Result<()> {
    let answer = base64(&sha1(format!("{}{}", key, GUID).as_bytes()));
    write!(
        stream,
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Accept: {}\r\n\r\n",
        answer
    )
}

pub fn refuse(stream: &mut TcpStream) {
    let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
}

pub fn frame(buf: &mut [u8], opcode: u8) -> usize {
    let len = buf.len() - HEADER;
    let start = match len {
        0..=125 => {
            buf[HEADER - 1] = len as u8;
            HEADER - 2
        }
        126..=0xffff => {
            buf[HEADER - 3] = 126;
            buf[HEADER - 2..HEADER].copy_from_slice(&(len as u16).to_be_bytes());
            HEADER - 4
        }
        _ => {
            buf[HEADER - 9] = 127;
            buf[HEADER - 8..HEADER].copy_from_slice(&(len as u64).to_be_bytes());
            0
        }
    };
    buf[start] = 0x80 | opcode;
    start
}

pub struct Reader {
    stream: TcpStream,
}

impl Reader {
    pub fn new(stream: TcpStream) -> Reader {
        Reader { stream }
    }

    pub fn next(&mut self) -> io::Result<Option<(u8, Vec<u8>)>> {
        let mut message = Vec::new();
        let mut kind = 0;
        loop {
            let mut head = [0u8; 2];
            self.stream.read_exact(&mut head)?;
            let fin = head[0] & 0x80 != 0;
            let opcode = head[0] & 0x0f;
            let masked = head[1] & 0x80 != 0;
            let mut len = (head[1] & 0x7f) as u64;
            if len == 126 {
                let mut l = [0u8; 2];
                self.stream.read_exact(&mut l)?;
                len = u16::from_be_bytes(l) as u64;
            } else if len == 127 {
                let mut l = [0u8; 8];
                self.stream.read_exact(&mut l)?;
                len = u64::from_be_bytes(l);
            }
            if len > MAX_MESSAGE || message.len() as u64 + len > MAX_MESSAGE {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "message too long"));
            }
            let mut mask = [0u8; 4];
            if masked {
                self.stream.read_exact(&mut mask)?;
            }
            let mut payload = vec![0u8; len as usize];
            self.stream.read_exact(&mut payload)?;
            if masked {
                for (i, b) in payload.iter_mut().enumerate() {
                    *b ^= mask[i % 4];
                }
            }
            match opcode {
                CLOSE => return Ok(None),
                PING => {
                    let mut pong = vec![0u8; HEADER];
                    pong.extend_from_slice(&payload);
                    let start = frame(&mut pong, PONG);
                    (&self.stream).write_all(&pong[start..])?;
                    continue;
                }
                PONG => continue,
                TEXT | BINARY => kind = opcode,
                _ => {}
            }
            message.extend_from_slice(&payload);
            if fin {
                return Ok(Some((kind, message)));
            }
        }
    }
}

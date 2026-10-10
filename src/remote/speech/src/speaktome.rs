
use crate::recognizer;
use log::info;
use serde_json::{json, Value};
use std::cell::Cell;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

const ADDRESS: &str = "127.0.0.1:8321";
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 60 * 16000 * 2 + 1024;
const MIN_CONFIDENCE: f32 = 0.15;

pub fn start() {
    let listener = match TcpListener::bind(ADDRESS) {
        Ok(l) => l,
        Err(e) => return info!("Web Speech can't listen on {}: {}", ADDRESS, e),
    };
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || handle(stream));
        }
    });
}

struct Request {
    method: String,
    path: String,
    head: String,
    body: Vec<u8>,
}

fn header<'a>(head: &'a str, name: &str) -> &'a str {
    head.split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(n, _)| n.trim().eq_ignore_ascii_case(name))
        .map_or("", |(_, v)| v.trim())
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 16384];
    let end = loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let mut first = head.split("\r\n").next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let path = first.next().unwrap_or("").split('?').next().unwrap_or("").to_string();
    let mut body = buf[end + 4..].to_vec();
    let length: usize = header(&head, "Content-Length").parse().unwrap_or(0);
    if length <= MAX_BODY {
        while body.len() < length {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return None,
                Ok(n) => body.extend_from_slice(&chunk[..n]),
            }
        }
        body.truncate(length);
    }
    Some(Request { method, path, head, body })
}

fn respond(stream: &mut TcpStream, status: u16, origin: &str, allow_headers: &str, body: &str) {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let mut h = format!("HTTP/1.1 {} {}\r\n", status, reason);
    if !origin.is_empty() {
        h += &format!(
            "Access-Control-Allow-Origin: {}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
             Access-Control-Allow-Headers: {}\r\nAccess-Control-Max-Age: 86400\r\nVary: Origin\r\n",
            origin, allow_headers
        );
    }
    if status != 204 {
        h += "Content-Type: application/json\r\n";
    }
    h += &format!("Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}", body.len(), body);
    let _ = stream.write_all(h.as_bytes());
}

fn failed(message: &str) -> String {
    json!({"status": "error", "message": message}).to_string()
}

fn gone(stream: &TcpStream, next: &Cell<Instant>) -> bool {
    if Instant::now() < next.get() {
        return false;
    }
    next.set(Instant::now() + Duration::from_millis(50));
    match stream.peek(&mut [0u8; 1]) {
        Ok(n) => n == 0,
        Err(e) => e.kind() != ErrorKind::WouldBlock && e.kind() != ErrorKind::Interrupted,
    }
}

fn handle(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_nodelay(true);
    let req = match read_request(&mut stream) {
        Some(r) => r,
        None => return,
    };
    let origin = header(&req.head, "Origin").to_string();
    if req.path != "/speaktome" && req.path != "/speaktome/" {
        return respond(&mut stream, 404, "", "", r#"{"error":"not found"}"#);
    }
    if req.method == "OPTIONS" {
        let asked = header(&req.head, "Access-Control-Request-Headers");
        return respond(&mut stream, 204, &origin, if asked.is_empty() { "Content-Type" } else { asked }, "");
    }
    if req.method != "POST" || req.body.is_empty() || req.body.len() > MAX_BODY {
        return respond(&mut stream, 200, &origin, "Content-Type", &failed("POST up to 60 s of audio"));
    }
    let lang = header(&req.head, "Accept-Language-STT")
        .split(|c| c == '-' || c == '_')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let lang = if lang.is_empty() { None } else { Some(lang.as_str()) };

    let _ = stream.set_nonblocking(true);
    let next = Cell::new(Instant::now());
    let result = recognizer::transcribe(&req.body, lang, &|| gone(&stream, &next));
    let _ = stream.set_nonblocking(false);
    let body = match result {
        Ok((text, confidence, _, _)) if !text.is_empty() && confidence >= MIN_CONFIDENCE => {
            let c: Value = format!("{:.3}", confidence).parse::<f64>().map(Value::from).unwrap_or(Value::Null);
            json!({"status": "ok", "data": [{"text": text, "confidence": c}]}).to_string()
        }
        Ok(_) => failed("no speech"),
        Err(e) => failed(&e),
    };
    respond(&mut stream, 200, &origin, "Content-Type", &body);
}


use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const USERINIT: &str = "/data/local/userinit";
const MAX_LINE: usize = 4096;

struct Config {
    socket: String,
    bridge_uid: Option<u32>,
    callrec_uid: Option<u32>,
}

struct Script {
    name: &'static str,
    path: &'static str,
    verbs: &'static [&'static str],
    chars: fn(u8) -> bool,
}

const SCRIPTS: [Script; 2] = [
    Script {
        name: "flipfull",
        path: "flipfull",
        verbs: &[
            "state", "features", "set", "removable", "google-client", "log", "restart", "reboot", "update",
            "uninstall",
        ],
        chars: |c| c.is_ascii_alphanumeric() || b"._-".contains(&c),
    },
    Script {
        name: "store",
        path: "store.sh",
        verbs: &["stage", "stage-file", "install", "install-pwa", "uninstall", "installed"],
        chars: |c| c.is_ascii_alphanumeric() || b"._~:/?#@!$&+,;=%-".contains(&c),
    },
];

fn log(msg: &str) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("{} {}", secs, msg);
}

fn usage() -> ! {
    eprintln!("usage: toolboxd --socket PATH [--bridge-uid N] [--callrec-uid N]");
    std::process::exit(2);
}

fn parse_args() -> Config {
    let mut c = Config { socket: String::new(), bridge_uid: None, callrec_uid: None };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let v = args.next().unwrap_or_else(|| usage());
        match a.as_str() {
            "--socket" => c.socket = v,
            "--bridge-uid" => c.bridge_uid = v.parse().ok(),
            "--callrec-uid" => c.callrec_uid = v.parse().ok(),
            _ => usage(),
        }
    }
    if c.socket.is_empty() {
        usage();
    }
    c
}

fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let r = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    if r == 0 {
        Some(cred.uid)
    } else {
        None
    }
}

fn read_request(stream: &UnixStream) -> Result<(String, Option<OwnedFd>), &'static str> {
    let mut line = Vec::new();
    let mut fd = None;
    let mut buf = [0u8; 512];
    let mut control = [0u8; 64];
    while !line.contains(&b'\n') {
        if line.len() > MAX_LINE {
            return Err("Too long");
        }
        let mut iov = libc::iovec { iov_base: buf.as_mut_ptr() as *mut libc::c_void, iov_len: buf.len() };
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = control.as_mut_ptr() as *mut libc::c_void;
        msg.msg_controllen = control.len() as _;
        let n = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut msg, libc::MSG_CMSG_CLOEXEC) };
        if n <= 0 {
            return Err("No command");
        }
        unsafe {
            let mut c = libc::CMSG_FIRSTHDR(&msg);
            while !c.is_null() {
                if (*c).cmsg_level == libc::SOL_SOCKET && (*c).cmsg_type == libc::SCM_RIGHTS {
                    let got = libc::CMSG_DATA(c) as *const RawFd;
                    let count = ((*c).cmsg_len as usize - libc::CMSG_LEN(0) as usize) / std::mem::size_of::<RawFd>();
                    for i in 0..count {
                        let owned = OwnedFd::from_raw_fd(*got.add(i));
                        fd.get_or_insert(owned);
                    }
                }
                c = libc::CMSG_NXTHDR(&msg, c);
            }
        }
        line.extend_from_slice(&buf[..n as usize]);
    }
    let end = line.iter().position(|&b| b == b'\n').unwrap_or(line.len());
    line.truncate(end);
    String::from_utf8(line).map(|l| (l, fd)).map_err(|_| "Not a command")
}

fn answer(stream: &mut UnixStream, ok: bool, text: &[u8]) {
    let _ = stream.write_all(if ok { b"ok\n" } else { b"error\n" });
    let _ = stream.write_all(text);
}

fn output(path: &str, args: &[&str]) -> std::io::Result<(ExitStatus, Vec<u8>)> {
    let mut fds = [0 as RawFd; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let (mut read, write) = unsafe { (File::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    // the Command and its copy of the write end drop here, otherwise the read never ends
    let mut child = Command::new("/system/bin/sh")
        .arg(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(write.try_clone()?))
        .stderr(Stdio::from(write))
        .spawn()?;
    let mut text = Vec::new();
    let read_out = read.read_to_end(&mut text);
    let status = child.wait()?;
    read_out?;
    Ok((status, text))
}

fn run_script(stream: &mut UnixStream, words: &[&str]) {
    let script = match SCRIPTS.iter().find(|s| s.name == words[0]) {
        Some(s) => s,
        None => return answer(stream, false, format!("Not a command: {}\n", words[0]).as_bytes()),
    };
    let args = &words[1..];
    if let Some(bad) = args.iter().find(|w| !w.bytes().all(script.chars)) {
        return answer(stream, false, format!("Not a command: {}\n", bad).as_bytes());
    }
    match args.first() {
        Some(verb) if script.verbs.contains(verb) => {}
        Some(verb) => return answer(stream, false, format!("Not a command: {}\n", verb).as_bytes()),
        None => return answer(stream, false, b"No command\n"),
    }
    let path = format!("{}/{}", USERINIT, script.path);
    match output(&path, args) {
        Ok((status, mut text)) => {
            log(&format!("{} {} -> {}", script.name, args[0], status.code().unwrap_or(-1)));
            while text.last() == Some(&b'\n') {
                text.pop();
            }
            text.push(b'\n');
            answer(stream, status.success(), &text)
        }
        Err(e) => {
            log(&format!("{} {}: {}", script.name, args[0], e));
            answer(stream, false, format!("couldn't run {}: {}\n", path, e).as_bytes())
        }
    }
}

fn record(stream: UnixStream, file: OwnedFd) {
    let callcap = format!("{}/bin/callcap", USERINIT);
    let (input, output) = match (stream.try_clone(), stream.try_clone()) {
        (Ok(i), Ok(o)) => (i, o),
        _ => return,
    };
    let fd = file.as_raw_fd();
    let child = unsafe {
        Command::new(&callcap)
            .stdin(Stdio::from(OwnedFd::from(input)))
            .stdout(Stdio::from(OwnedFd::from(output)))
            .pre_exec(move || {
                // dup2 onto itself keeps FD_CLOEXEC
                let r = if fd == 3 { libc::fcntl(3, libc::F_SETFD, 0) } else { libc::dup2(fd, 3) };
                if r < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            })
            .spawn()
    };
    drop(file);
    drop(stream);
    match child {
        Ok(mut child) => {
            log(&format!("record: callcap pid {}", child.id()));
            let status = child.wait();
            log(&format!("record: callcap ended ({:?})", status.map(|s| s.code())));
        }
        Err(e) => log(&format!("record: couldn't run {}: {}", callcap, e)),
    }
}

fn handle(config: &Config, mut stream: UnixStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let uid = peer_uid(&stream);
    let bridge = uid.is_some() && uid == config.bridge_uid;
    let callrec = uid.is_some() && uid == config.callrec_uid;
    if !bridge && !callrec {
        log(&format!("refused uid {:?}", uid));
        return answer(&mut stream, false, b"Only Flipfull's services\n");
    }
    let (line, fd) = match read_request(&stream) {
        Ok(r) => r,
        Err(why) => return answer(&mut stream, false, format!("{}\n", why).as_bytes()),
    };
    let words: Vec<&str> = line.split(' ').filter(|w| !w.is_empty()).collect();
    match (words.first(), fd) {
        (Some(&"record"), Some(file)) if callrec && words.len() == 1 => {
            let _ = stream.set_read_timeout(None);
            record(stream, file)
        }
        (Some(_), None) if bridge => run_script(&mut stream, &words),
        _ => answer(&mut stream, false, b"Not a command\n"),
    }
}

fn main() {
    let config: &'static Config = Box::leak(Box::new(parse_args()));
    let _ = fs::remove_file(&config.socket);
    let listener = match UnixListener::bind(&config.socket) {
        Ok(l) => l,
        Err(e) => {
            log(&format!("can't listen on {}: {}", config.socket, e));
            std::process::exit(1);
        }
    };
    let _ = fs::set_permissions(&config.socket, fs::Permissions::from_mode(0o666));
    log(&format!("listening on {} for uids {:?} and {:?}", config.socket, config.bridge_uid, config.callrec_uid));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                thread::spawn(move || handle(config, stream));
            }
            Err(e) => {
                log(&format!("accept: {}", e));
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use toolbox::{Answer, Request, Role, Script, REGISTRY};

const USERINIT: &str = "/data/local/userinit";

fn log(msg: &str) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("{} {}", secs, msg);
}

fn usage() -> ! {
    eprintln!("usage: toolboxd --socket PATH");
    std::process::exit(2);
}

fn parse_args() -> String {
    let mut socket = String::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let v = args.next().unwrap_or_else(|| usage());
        match a.as_str() {
            "--socket" => socket = v,
            _ => usage(),
        }
    }
    if socket.is_empty() {
        usage();
    }
    socket
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

fn role(stream: &UnixStream) -> Result<Role, Option<u32>> {
    let uid = peer_uid(stream);
    let registry = fs::read_to_string(REGISTRY).unwrap_or_default();
    uid.and_then(|u| Role::of_uid(u, &registry)).ok_or(uid)
}

fn output(path: &str, args: &[String]) -> std::io::Result<(ExitStatus, Vec<u8>)> {
    let mut fds = [0 as RawFd; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let (mut read, write) = unsafe { (File::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
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

fn run_script(script: &Script) -> Answer {
    let path = format!("{}/{}", USERINIT, script.file());
    let args = script.words();
    match output(&path, args) {
        Ok((status, mut text)) => {
            log(&format!("{} {} -> {}", script.name(), args[0], status.code().unwrap_or(-1)));
            while text.last() == Some(&b'\n') {
                text.pop();
            }
            text.push(b'\n');
            Answer::Text { ok: status.success(), text: String::from_utf8_lossy(&text).into_owned() }
        }
        Err(e) => {
            log(&format!("{} {}: {}", script.name(), args[0], e));
            Answer::error(format!("couldn't run {}: {}", path, e))
        }
    }
}

fn record(stream: UnixStream, file: File) {
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

fn request(stream: &mut UnixStream) -> Result<Request, String> {
    let role = role(stream).map_err(|uid| {
        log(&format!("refused uid {:?}", uid));
        "Only Flipfull's services".to_string()
    })?;
    let request = Request::read(stream)?;
    if role.allows(&request) {
        Ok(request)
    } else {
        Err("Not a command".into())
    }
}

fn handle(mut stream: UnixStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let answer = match request(&mut stream) {
        Ok(Request::Record(file)) => {
            let _ = stream.set_read_timeout(None);
            return record(stream, file);
        }
        Ok(Request::Script(script)) => Ok(run_script(&script)),
        Err(why) => Err(why),
    };
    if let Err(e) = answer.unwrap_or_else(Answer::error).send(&mut stream) {
        log(&format!("answer: {}", e));
    }
}

fn main() {
    let socket = parse_args();
    let _ = fs::remove_file(&socket);
    let listener = match UnixListener::bind(&socket) {
        Ok(l) => l,
        Err(e) => {
            log(&format!("can't listen on {}: {}", socket, e));
            std::process::exit(1);
        }
    };
    let _ = fs::set_permissions(&socket, fs::Permissions::from_mode(0o666));
    log(&format!("listening on {} for the remote services in {}", socket, REGISTRY));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                thread::spawn(move || handle(stream));
            }
            Err(e) => {
                log(&format!("accept: {}", e));
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

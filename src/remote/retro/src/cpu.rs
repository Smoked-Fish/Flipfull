use log::{info, warn};
use nix::sched::{sched_setaffinity, CpuSet};
use nix::unistd::Pid;
use std::fs;

const UTIL_MIN: u32 = 1024;
const SCHED_FLAG_KEEP_POLICY: u64 = 0x08;
const SCHED_FLAG_KEEP_PARAMS: u64 = 0x10;
const SCHED_FLAG_UTIL_CLAMP_MIN: u64 = 0x20;

#[repr(C)]
#[derive(Default)]
struct SchedAttr {
    size: u32,
    sched_policy: u32,
    sched_flags: u64,
    sched_nice: i32,
    sched_priority: u32,
    sched_runtime: u64,
    sched_deadline: u64,
    sched_period: u64,
    sched_util_min: u32,
    sched_util_max: u32,
}

fn max_freq(cpu: usize) -> Option<u64> {
    fs::read_to_string(format!("/sys/devices/system/cpu/cpu{}/cpufreq/cpuinfo_max_freq", cpu))
        .ok()?
        .trim()
        .parse()
        .ok()
}

pub fn fast() {
    let freqs: Vec<(usize, u64)> = (0..CpuSet::count().min(64)).filter_map(|c| max_freq(c).map(|f| (c, f))).collect();
    let top = freqs.iter().map(|&(_, f)| f).max().unwrap_or(0);
    let mut set = CpuSet::new();
    let mut cpus = Vec::new();
    for &(cpu, f) in &freqs {
        if f == top && set.set(cpu).is_ok() {
            cpus.push(cpu);
        }
    }
    let pinned = !cpus.is_empty() && sched_setaffinity(Pid::from_raw(0), &set).is_ok();

    let attr = SchedAttr {
        size: std::mem::size_of::<SchedAttr>() as u32,
        sched_flags: SCHED_FLAG_KEEP_POLICY | SCHED_FLAG_KEEP_PARAMS | SCHED_FLAG_UTIL_CLAMP_MIN,
        sched_util_min: UTIL_MIN,
        ..SchedAttr::default()
    };
    let clamped = unsafe { libc::syscall(libc::SYS_sched_setattr, 0, &attr as *const SchedAttr, 0) } == 0;
    let why = if clamped { String::new() } else { format!(" ({})", std::io::Error::last_os_error()) };
    if pinned || clamped {
        info!("emulation on cpus {:?}{}, utilization floor {}", cpus, if pinned { "" } else { " (not pinned)" },
            if clamped { UTIL_MIN.to_string() } else { format!("refused{}", why) });
    } else {
        warn!("emulation left where the scheduler puts it{}", why);
    }
}

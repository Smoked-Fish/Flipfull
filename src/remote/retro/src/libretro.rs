use crate::settings;
use crate::video::{Colors, Video};
use flipfull_remote::own_dir;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_uint, c_void};
use std::ptr;
use std::sync::{Mutex, MutexGuard, Once, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const ENV_GET_SYSTEM_DIRECTORY: c_uint = 9;
const ENV_SET_PIXEL_FORMAT: c_uint = 10;
const ENV_GET_VARIABLE: c_uint = 15;
const ENV_GET_VARIABLE_UPDATE: c_uint = 17;
const ENV_GET_INPUT_BITMASKS: c_uint = 51 | 0x10000;
const DEVICE_JOYPAD: c_uint = 1;
const JOYPAD_MASK: c_uint = 256;
const MEMORY_SAVE_RAM: c_uint = 0;
const PIXEL_XRGB8888: u32 = 1;
const PIXEL_RGB565: u32 = 2;
const MBC3_CLOCK: usize = 48;
const MBC3_CLOCK_TIME: usize = 40;

#[repr(C)]
struct GameInfo {
    path: *const c_char,
    data: *const c_void,
    size: usize,
    meta: *const c_char,
}

#[repr(C)]
struct SystemInfo {
    library_name: *const c_char,
    library_version: *const c_char,
    valid_extensions: *const c_char,
    need_fullpath: bool,
    block_extract: bool,
}

#[repr(C)]
#[derive(Default)]
struct Geometry {
    base_width: c_uint,
    base_height: c_uint,
    max_width: c_uint,
    max_height: c_uint,
    aspect_ratio: f32,
}

#[repr(C)]
#[derive(Default)]
struct Timing {
    fps: f64,
    sample_rate: f64,
}

#[repr(C)]
#[derive(Default)]
struct AvInfo {
    geometry: Geometry,
    timing: Timing,
}

#[repr(C)]
struct Variable {
    key: *const c_char,
    value: *const c_char,
}

extern "C" {
    fn retro_set_environment(cb: extern "C" fn(c_uint, *mut c_void) -> bool);
    fn retro_set_video_refresh(cb: extern "C" fn(*const c_void, c_uint, c_uint, usize));
    fn retro_set_audio_sample(cb: extern "C" fn(i16, i16));
    fn retro_set_audio_sample_batch(cb: extern "C" fn(*const i16, usize) -> usize);
    fn retro_set_input_poll(cb: extern "C" fn());
    fn retro_set_input_state(cb: extern "C" fn(c_uint, c_uint, c_uint, c_uint) -> i16);
    fn retro_init();
    fn retro_get_system_info(info: *mut SystemInfo);
    fn retro_get_system_av_info(info: *mut AvInfo);
    fn retro_load_game(game: *const GameInfo) -> bool;
    fn retro_unload_game();
    fn retro_run();
    fn retro_reset();
    fn retro_serialize_size() -> usize;
    fn retro_serialize(data: *mut c_void, size: usize) -> bool;
    fn retro_unserialize(data: *const c_void, size: usize) -> bool;
    fn retro_get_memory_data(id: c_uint) -> *mut c_void;
    fn retro_get_memory_size(id: c_uint) -> usize;
    fn flipfull_state_size() -> usize;
    fn flipfull_save_state(state: *mut c_void) -> bool;
    fn flipfull_load_state(state: *const c_void) -> bool;
    fn flipfull_draw_next(draw: bool);
    fn flipfull_drain_audio();
    fn flipfull_set_audio_rate(rate: f64);
    fn flipfull_set_utc_offset(seconds: i64);
    fn flipfull_save_size() -> usize;
    fn flipfull_flush_save();
    fn flipfull_gb_palette(i: usize) -> *const c_char;
    fn flipfull_platform() -> i32;
}

#[derive(Default)]
struct Output {
    format: u32,
    width: usize,
    height: usize,
    frames: [Vec<u16>; 2],
    slot: Option<usize>,
    audio: Vec<i16>,
    keys: u16,
}

fn output() -> MutexGuard<'static, Output> {
    static OUTPUT: OnceLock<Mutex<Output>> = OnceLock::new();
    OUTPUT.get_or_init(Mutex::default).lock().unwrap()
}

fn system_dir() -> &'static CString {
    static DIR: OnceLock<CString> = OnceLock::new();
    DIR.get_or_init(|| CString::new(own_dir().to_string_lossy().into_owned()).unwrap_or_default())
}

extern "C" fn environment(cmd: c_uint, data: *mut c_void) -> bool {
    match cmd {
        ENV_SET_PIXEL_FORMAT if !data.is_null() => {
            let format = unsafe { *(data as *const u32) };
            if format > PIXEL_RGB565 {
                return false;
            }
            output().format = format;
            true
        }
        ENV_GET_SYSTEM_DIRECTORY if !data.is_null() => {
            unsafe { *(data as *mut *const c_char) = system_dir().as_ptr() };
            true
        }
        ENV_GET_VARIABLE if !data.is_null() => {
            let var = unsafe { &mut *(data as *mut Variable) };
            if var.key.is_null() {
                return false;
            }
            match settings::core_option(unsafe { CStr::from_ptr(var.key) }) {
                Some(value) => {
                    var.value = value.as_ptr();
                    true
                }
                None => false,
            }
        }
        ENV_GET_VARIABLE_UPDATE if !data.is_null() => {
            unsafe { *(data as *mut bool) = settings::take_update() };
            true
        }
        ENV_GET_INPUT_BITMASKS => true,
        _ => false,
    }
}

fn rgb565(pixel: u32, format: u32) -> u16 {
    match format {
        PIXEL_XRGB8888 => (((pixel >> 8) & 0xf800) | ((pixel >> 5) & 0x07e0) | ((pixel >> 3) & 0x001f)) as u16,
        // 0rgb1555, green's top bit again as the sixth
        _ => (((pixel & 0x7fe0) << 1) | ((pixel >> 4) & 0x20) | (pixel & 0x1f)) as u16,
    }
}

extern "C" fn video(data: *const c_void, width: c_uint, height: c_uint, pitch: usize) {
    let mut out = output();
    let slot = match out.slot {
        Some(s) if !data.is_null() => s,
        _ => return,
    };
    let format = out.format;
    let (w, h) = (width as usize, height as usize);
    out.width = w;
    out.height = h;
    let frame = &mut out.frames[slot];
    frame.resize(w * h, 0);
    for y in 0..h {
        let src = unsafe { (data as *const u8).add(y * pitch) };
        let dst = &mut frame[y * w..(y + 1) * w];
        match format {
            PIXEL_RGB565 => dst.copy_from_slice(unsafe { std::slice::from_raw_parts(src as *const u16, w) }),
            PIXEL_XRGB8888 => {
                let row = unsafe { std::slice::from_raw_parts(src as *const u32, w) };
                for (d, &p) in dst.iter_mut().zip(row) {
                    *d = rgb565(p, format);
                }
            }
            _ => {
                let row = unsafe { std::slice::from_raw_parts(src as *const u16, w) };
                for (d, &p) in dst.iter_mut().zip(row) {
                    *d = rgb565(p as u32, format);
                }
            }
        }
    }
}

extern "C" fn audio_sample(left: i16, right: i16) {
    output().audio.extend_from_slice(&[left, right]);
}

extern "C" fn audio_batch(data: *const i16, frames: usize) -> usize {
    if !data.is_null() {
        output().audio.extend_from_slice(unsafe { std::slice::from_raw_parts(data, frames * 2) });
    }
    frames
}

extern "C" fn input_poll() {}

extern "C" fn input_state(port: c_uint, device: c_uint, _index: c_uint, id: c_uint) -> i16 {
    if port != 0 || device != DEVICE_JOYPAD {
        return 0;
    }
    let keys = output().keys;
    match id {
        JOYPAD_MASK => keys as i16,
        0..=15 => ((keys >> id) & 1) as i16,
        _ => 0,
    }
}

fn start() {
    static START: Once = Once::new();
    START.call_once(|| unsafe {
        retro_set_environment(environment);
        retro_set_video_refresh(video);
        retro_set_audio_sample(audio_sample);
        retro_set_audio_sample_batch(audio_batch);
        retro_set_input_poll(input_poll);
        retro_set_input_state(input_state);
        retro_init();
    });
}

fn text(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}

pub fn info() -> (String, String, String) {
    let mut i = SystemInfo {
        library_name: ptr::null(),
        library_version: ptr::null(),
        valid_extensions: ptr::null(),
        need_fullpath: false,
        block_extract: false,
    };
    unsafe { retro_get_system_info(&mut i) };
    (text(i.library_name), text(i.library_version), text(i.valid_extensions))
}

pub fn gb_palettes() -> Vec<String> {
    (0..).map(|i| unsafe { flipfull_gb_palette(i) }).take_while(|p| !p.is_null()).map(text).collect()
}

fn save_memory() -> &'static mut [u8] {
    unsafe {
        let data = retro_get_memory_data(MEMORY_SAVE_RAM) as *mut u8;
        let size = flipfull_save_size();
        if data.is_null() || size == 0 {
            &mut []
        } else {
            std::slice::from_raw_parts_mut(data, size)
        }
    }
}

fn run(keys: u16, slot: Option<usize>) {
    {
        let mut out = output();
        out.keys = keys;
        out.slot = slot;
    }
    unsafe {
        flipfull_draw_next(slot.is_some());
        retro_run();
        flipfull_drain_audio();
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum Platform {
    Gba,
    Gb,
}

impl Platform {
    pub fn handheld_colors(self) -> Colors {
        match self {
            Platform::Gba => Colors::Gba,
            Platform::Gb => Colors::Gbc,
        }
    }
}

#[derive(Clone, Copy)]
pub struct Game {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub rate: f64,
    pub platform: Platform,
}

#[derive(Default)]
pub struct Frontend {
    loaded: bool,
    before: Vec<u8>,
    ram_before: Vec<u8>,
    video: Video,
}

impl Frontend {
    fn check(&self) -> Result<(), String> {
        if self.loaded {
            Ok(())
        } else {
            Err("no game is loaded".into())
        }
    }

    pub fn load(&mut self, rom: &[u8], save: &[u8]) -> Result<Game, String> {
        start();
        self.unload();
        {
            let mut out = output();
            out.frames = Default::default();
            out.audio.clear();
            out.keys = 0;
        }
        // mgba goes by the rom, not the name
        let path = CString::new("game").unwrap();
        let game = GameInfo { path: path.as_ptr(), data: rom.as_ptr() as *const c_void, size: rom.len(), meta: ptr::null() };
        if rom.is_empty() || !unsafe { retro_load_game(&game) } {
            return Err("the core can't play this file".into());
        }
        self.loaded = true;
        let memory = save_memory();
        let n = save.len().min(memory.len());
        memory[..n].copy_from_slice(&save[..n]);
        let ram = unsafe { retro_get_memory_size(MEMORY_SAVE_RAM) };
        if memory.len() == ram + MBC3_CLOCK && n < memory.len() {
            // no saved time, start from now instead of the 0xff bytes
            let clock = &mut memory[ram..];
            clock.iter_mut().for_each(|b| *b = 0);
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            clock[MBC3_CLOCK_TIME..MBC3_CLOCK_TIME + 8].copy_from_slice(&now.to_le_bytes());
        }
        self.video.forget();
        let mut av = AvInfo::default();
        unsafe { retro_get_system_av_info(&mut av) };
        Ok(Game {
            width: av.geometry.base_width,
            height: av.geometry.base_height,
            fps: av.timing.fps,
            rate: av.timing.sample_rate,
            platform: if unsafe { flipfull_platform() } == 1 { Platform::Gba } else { Platform::Gb },
        })
    }

    pub fn frame(&mut self, keys: u16, slot: Option<usize>) {
        if self.loaded {
            run(keys, slot);
        }
    }

    pub fn ahead(&mut self) -> bool {
        if !self.loaded {
            return false;
        }
        let size = unsafe { flipfull_state_size() };
        self.before.resize(size, 0);
        self.ram_before.clear();
        self.ram_before.extend_from_slice(save_memory());
        size > 0 && unsafe { flipfull_save_state(self.before.as_mut_ptr() as *mut c_void) }
    }

    pub fn back(&mut self) {
        unsafe { flipfull_load_state(self.before.as_ptr() as *const c_void) };
        output().audio.clear();
        let ram = save_memory();
        if ram.len() == self.ram_before.len() && *ram != *self.ram_before {
            ram.copy_from_slice(&self.ram_before);
        }
    }

    pub fn audio(&mut self, into: &mut Vec<i16>) {
        let mut out = output();
        into.extend_from_slice(&out.audio);
        out.audio.clear();
    }

    pub fn set_audio_rate(&mut self, rate: f64) {
        if self.loaded && rate > 0.0 {
            unsafe { flipfull_set_audio_rate(rate) };
        }
    }

    pub fn set_utc_offset(&mut self, seconds: i64) {
        if self.loaded {
            unsafe { flipfull_set_utc_offset(seconds) };
        }
    }

    pub fn picture(&mut self, into: &mut Vec<u8>, mix: bool, colors: Colors) -> (usize, usize, usize, usize) {
        {
            let out = output();
            let before = if mix { Some(&out.frames[0][..]) } else { None };
            self.video.compose(before, &out.frames[1], out.width, out.height, colors);
        }
        self.video.band(into)
    }

    pub fn forget_picture(&mut self) {
        self.video.forget();
    }

    pub fn save_data(&mut self, flush: bool) -> &[u8] {
        if !self.loaded {
            return &[];
        }
        if flush {
            unsafe { flipfull_flush_save() };
        }
        save_memory()
    }

    pub fn reset(&mut self) -> Result<(), String> {
        self.check()?;
        unsafe { retro_reset() };
        Ok(())
    }

    pub fn save_state(&mut self) -> Result<Vec<u8>, String> {
        self.check()?;
        let size = unsafe { retro_serialize_size() };
        let mut state = vec![0u8; size];
        if size == 0 || !unsafe { retro_serialize(state.as_mut_ptr() as *mut c_void, size) } {
            return Err("the core couldn't save its state".into());
        }
        Ok(state)
    }

    pub fn load_state(&mut self, state: &[u8]) -> Result<(), String> {
        self.check()?;
        if !unsafe { retro_unserialize(state.as_ptr() as *const c_void, state.len()) } {
            return Err("the state isn't one of this game's".into());
        }
        Ok(())
    }

    pub fn unload(&mut self) {
        if std::mem::take(&mut self.loaded) {
            unsafe { retro_unload_game() };
        }
    }
}

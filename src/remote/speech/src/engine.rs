use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_long, c_void};

#[repr(C)]
struct RawModel {
    _private: [u8; 0],
}

extern "C" {
    fn stt_set_log(log: extern "C" fn(*const c_char));
    fn stt_load(path: *const c_char, threads: c_int, english: c_int) -> *mut RawModel;
    fn stt_free(m: *mut RawModel);
    fn stt_transcribe(
        m: *mut RawModel,
        audio: *const u8,
        len: usize,
        lang: *const c_char,
        abort: extern "C" fn(*mut c_void) -> c_int,
        data: *mut c_void,
        text: *mut *mut c_char,
        confidence: *mut f32,
        audio_ms: *mut c_long,
        err: *mut c_char,
        err_size: usize,
    ) -> c_int;
    fn stt_text_free(text: *mut c_char);
}

extern "C" fn log_line(line: *const c_char) {
    log::error!("{}", unsafe { CStr::from_ptr(line) }.to_string_lossy());
}

pub fn init() {
    unsafe { stt_set_log(log_line) };
}

pub struct Model(*mut RawModel);

unsafe impl Send for Model {}

impl Model {
    pub fn load(path: &str, threads: usize, english: bool) -> Option<Model> {
        let path = CString::new(path).ok()?;
        let raw = unsafe { stt_load(path.as_ptr(), threads as c_int, english as c_int) };
        if raw.is_null() {
            None
        } else {
            Some(Model(raw))
        }
    }

    pub fn transcribe(
        &mut self,
        audio: &[u8],
        lang: Option<&str>,
        stop: &dyn Fn() -> bool,
    ) -> Result<(String, f32, i64), String> {
        extern "C" fn ask(data: *mut c_void) -> c_int {
            let stop = unsafe { &*(data as *const &dyn Fn() -> bool) };
            stop() as c_int
        }
        let lang = lang.and_then(|l| CString::new(l).ok());
        let mut text: *mut c_char = std::ptr::null_mut();
        let mut confidence = 0f32;
        let mut audio_ms: c_long = 0;
        let mut err = [0 as c_char; 256];
        let ok = unsafe {
            stt_transcribe(
                self.0,
                audio.as_ptr(),
                audio.len(),
                lang.as_ref().map_or(std::ptr::null(), |l| l.as_ptr()),
                ask,
                &stop as *const &dyn Fn() -> bool as *mut c_void,
                &mut text,
                &mut confidence,
                &mut audio_ms,
                err.as_mut_ptr(),
                err.len(),
            )
        };
        if ok == 0 {
            return Err(unsafe { CStr::from_ptr(err.as_ptr()) }.to_string_lossy().into_owned());
        }
        let out = unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned();
        unsafe { stt_text_free(text) };
        Ok((out, confidence, audio_ms as i64))
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        unsafe { stt_free(self.0) };
    }
}

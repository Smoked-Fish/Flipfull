// u32 length then the message, little endian. picture header:
// 0 u8 kind, 1 u8 flags (PAUSED, HOLD), 2 u16 width, height, 6 u16 first changed row, rows,
// 10 u16 frames, 12 u32 samples a channel, 16 u32 emulation us, 20 u32 sent (us since play),
// 24 u64 compositor refresh (us since 1970), 32 rows rgb565, then left and right samples f32

use serde::Deserialize;

pub const KIND_PICTURE: u8 = 1;
pub const PAUSED: u8 = 2;
pub const HOLD: u8 = 4;
pub const HEADER: usize = 32;
pub const PREFIX: usize = 4;

#[derive(Default, Debug, PartialEq)]
pub struct Header {
    pub flags: u8,
    pub width: u16,
    pub height: u16,
    pub top: u16,
    pub rows: u16,
    pub frames: u16,
    pub samples: u32,
    pub work_us: u32,
    pub sent_us: u32,
    pub tick_us: u64,
}

impl Header {
    fn write(&self, m: &mut [u8]) {
        m[0] = KIND_PICTURE;
        m[1] = self.flags;
        m[2..4].copy_from_slice(&self.width.to_le_bytes());
        m[4..6].copy_from_slice(&self.height.to_le_bytes());
        m[6..8].copy_from_slice(&self.top.to_le_bytes());
        m[8..10].copy_from_slice(&self.rows.to_le_bytes());
        m[10..12].copy_from_slice(&self.frames.to_le_bytes());
        m[12..16].copy_from_slice(&self.samples.to_le_bytes());
        m[16..20].copy_from_slice(&self.work_us.to_le_bytes());
        m[20..24].copy_from_slice(&self.sent_us.to_le_bytes());
        m[24..32].copy_from_slice(&self.tick_us.to_le_bytes());
    }
}

#[derive(Default)]
pub struct Message {
    bytes: Vec<u8>,
}

impl Message {
    pub fn picture(&mut self) -> &mut Vec<u8> {
        self.bytes.clear();
        self.bytes.resize(PREFIX + HEADER, 0);
        &mut self.bytes
    }

    pub fn sound(&mut self, audio: &[i16]) -> usize {
        let samples = audio.len() / 2;
        self.bytes.reserve(samples * 8);
        for c in 0..2 {
            for frame in audio.chunks_exact(2) {
                self.bytes.extend_from_slice(&(frame[c] as f32 / 32768.0).to_le_bytes());
            }
        }
        samples
    }

    pub fn finish(&mut self, header: &Header) -> &[u8] {
        header.write(&mut self.bytes[PREFIX..PREFIX + HEADER]);
        let len = (self.bytes.len() - PREFIX) as u32;
        self.bytes[..PREFIX].copy_from_slice(&len.to_le_bytes());
        &self.bytes
    }

    pub fn paused(&mut self) -> &[u8] {
        self.picture();
        self.finish(&Header { flags: PAUSED, ..Header::default() })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub tick_us: f64,
    pub period_us: f64,
}

fn grid(tick: Option<f64>, period: Option<f64>) -> Option<Grid> {
    match (tick, period) {
        (Some(tick_us), Some(period_us)) if period_us > 4000.0 && period_us < 100_000.0 => {
            Some(Grid { tick_us, period_us })
        }
        _ => None,
    }
}

#[derive(Deserialize, Default, Debug, PartialEq)]
#[serde(default)]
pub struct PlayOptions {
    pub session: u64,
    pub rate: f64,
    tick: Option<f64>,
    period: Option<f64>,
}

impl PlayOptions {
    pub fn parse(json: &str) -> Option<PlayOptions> {
        serde_json::from_str(json).ok()
    }

    pub fn grid(&self) -> Option<Grid> {
        grid(self.tick, self.period)
    }
}

#[derive(Deserialize, Default, Debug, PartialEq)]
#[serde(default)]
pub struct SyncReport {
    tick: Option<f64>,
    period: Option<f64>,
    pub leads: Vec<f64>,
    pub sound: Option<f64>,
}

impl SyncReport {
    pub fn grid(&self) -> Option<Grid> {
        grid(self.tick, self.period)
    }
}

#[derive(Deserialize, Default, Debug, PartialEq)]
#[serde(default)]
pub struct WorkerMessage {
    pub keys: Option<u16>,
    pub fast: Option<bool>,
    pub pause: Option<u64>,
    pub sync: Option<SyncReport>,
}

impl WorkerMessage {
    pub fn parse(text: &[u8]) -> Result<WorkerMessage, String> {
        serde_json::from_slice(text).map_err(|e| e.to_string())
    }
}

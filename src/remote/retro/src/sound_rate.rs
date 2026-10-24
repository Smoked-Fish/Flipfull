const SKEW: f64 = 0.006;
const SKEW_P: f64 = 0.008;
const SKEW_I: f64 = 0.0001;
const SKEW_I_MAX: f64 = 0.004;

pub struct SoundRate {
    out_rate: f64,
    target: f64,
    buffered: f64,
    skew: f64,
    skew_sum: f64,
}

impl SoundRate {
    pub fn new() -> SoundRate {
        SoundRate { out_rate: 0.0, target: 0.1, buffered: 0.0, skew: 0.0, skew_sum: 0.0 }
    }

    pub fn start(&mut self, out_rate: f64, target: f64) {
        self.out_rate = out_rate;
        self.target = target;
        self.buffered = target * out_rate;
        self.skew = self.skew_sum;
    }

    pub fn sync(&mut self, buffered: f64) {
        self.buffered = buffered;
        if self.out_rate > 0.0 {
            let short = (self.target - buffered / self.out_rate) / self.target;
            let short = short.max(-1.0).min(1.0);
            self.skew_sum = (self.skew_sum + short * SKEW_I).max(-SKEW_I_MAX).min(SKEW_I_MAX);
            self.skew = (short * SKEW_P + self.skew_sum).max(-SKEW).min(SKEW);
        }
    }

    pub fn on(&self) -> bool {
        self.out_rate > 0.0
    }

    pub fn rate(&self, fps: f64, period: f64, core_rate: f64) -> f64 {
        if self.on() {
            self.out_rate * fps * period * (1.0 + self.skew)
        } else {
            core_rate
        }
    }

    pub fn buffered_ms(&self) -> f64 {
        if self.on() {
            self.buffered * 1000.0 / self.out_rate
        } else {
            0.0
        }
    }

    pub fn skew(&self) -> f64 {
        self.skew
    }
}

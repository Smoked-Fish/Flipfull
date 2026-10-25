const MASK: u16 = 0xf7de;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Colors {
    Vivid,
    Gba,
    Gbc,
}

// pokefan531's gba and gbc color shaders (libretro gba-color, gbc-color)
struct Lcd {
    matrix: [[f32; 3]; 3],
    lum: f32,
}

const GBA: Lcd = Lcd { matrix: [[0.82, 0.24, -0.06], [0.125, 0.665, 0.21], [0.195, 0.075, 0.73]], lum: 0.94 };
const GBC: Lcd = Lcd { matrix: [[0.78824, 0.12157, 0.0], [0.025, 0.72941, 0.275], [0.12039, 0.12157, 0.82]], lum: 0.94 };
const GAMMA: f32 = 2.2;

fn table(lcd: &Lcd) -> Vec<u16> {
    let linear = |v: u32, max: f32| (v as f32 / max).powf(GAMMA);
    let r5: Vec<f32> = (0..32).map(|v| linear(v, 31.0)).collect();
    let g6: Vec<f32> = (0..64).map(|v| linear(v, 63.0)).collect();
    let out = |v: f32, max: f32| ((v * lcd.lum).max(0.0).min(1.0).powf(1.0 / GAMMA) * max + 0.5) as u16;
    (0..=0xffffu32)
        .map(|c| {
            let rgb = [r5[(c >> 11) as usize], g6[((c >> 5) & 0x3f) as usize], r5[(c & 0x1f) as usize]];
            let m = &lcd.matrix;
            let ch = |i: usize| m[i][0] * rgb[0] + m[i][1] * rgb[1] + m[i][2] * rgb[2];
            (out(ch(0), 31.0) << 11) | (out(ch(1), 63.0) << 5) | out(ch(2), 31.0)
        })
        .collect()
}

#[derive(Default)]
pub struct Video {
    width: usize,
    height: usize,
    picture: Vec<u16>,
    shown: Vec<u16>,
    colors: Option<(Colors, Vec<u16>)>,
}

impl Video {
    fn correct(&mut self, colors: Colors) {
        let lcd = match colors {
            Colors::Vivid => return,
            Colors::Gba => &GBA,
            Colors::Gbc => &GBC,
        };
        if self.colors.as_ref().map_or(true, |(c, _)| *c != colors) {
            self.colors = Some((colors, table(lcd)));
        }
        if let Some((_, t)) = &self.colors {
            for p in self.picture.iter_mut() {
                *p = t[*p as usize];
            }
        }
    }

    pub fn compose(&mut self, before: Option<&[u16]>, last: &[u16], width: usize, height: usize, colors: Colors) {
        let n = width * height;
        if last.len() < n {
            return;
        }
        self.width = width;
        self.height = height;
        self.picture.resize(n, 0);
        match before.filter(|b| b.len() >= n) {
            Some(before) => {
                for ((p, &a), &b) in self.picture.iter_mut().zip(&before[..n]).zip(&last[..n]) {
                    *p = (a & b) + (((a ^ b) & MASK) >> 1);
                }
            }
            None => self.picture.copy_from_slice(&last[..n]),
        }
        self.correct(colors);
    }

    pub fn band(&mut self, into: &mut Vec<u8>) -> (usize, usize, usize, usize) {
        let w = self.width;
        let (first, end) = if w == 0 {
            (0, 0)
        } else if self.shown.len() != self.picture.len() {
            self.shown.clone_from(&self.picture);
            (0, self.height)
        } else {
            let differs = |(a, b): (&[u16], &[u16])| a != b;
            let rows = || self.picture.chunks(w).zip(self.shown.chunks(w));
            match rows().position(differs) {
                Some(first) => {
                    let end = rows().rposition(differs).unwrap_or(first) + 1;
                    let (a, b) = (first * w, end * w);
                    self.shown[a..b].copy_from_slice(&self.picture[a..b]);
                    (first, end)
                }
                None => (0, 0),
            }
        };
        let band = &self.picture[first * w..end * w];
        into.reserve(band.len() * 2);
        for p in band {
            into.extend_from_slice(&p.to_le_bytes());
        }
        (w, self.height, first, end - first)
    }

    pub fn forget(&mut self) {
        self.shown.clear();
    }
}

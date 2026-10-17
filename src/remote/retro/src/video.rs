#[derive(Default)]
pub struct Video {
    width: usize,
    height: usize,
    picture: Vec<u16>,
    shown: Vec<u16>,
}

impl Video {
    pub fn compose(&mut self, last: &[u16], width: usize, height: usize) {
        let n = width * height;
        if last.len() < n {
            return;
        }
        self.width = width;
        self.height = height;
        self.picture.resize(n, 0);
        self.picture.copy_from_slice(&last[..n]);
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
        for p in &self.picture[first * w..end * w] {
            into.extend_from_slice(&p.to_le_bytes());
        }
        (w, self.height, first, end - first)
    }

    pub fn forget(&mut self) {
        self.shown.clear();
    }
}

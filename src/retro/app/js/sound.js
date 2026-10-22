'use strict';

(function () {
    const LIMIT = 0.25;
    // the audio output takes 40-60ms at a time, start a bit over the buffer
    const OVER = 0.03;
    const REPORT = 0.25;
    const FADE = 64;

    class Sound extends AudioWorkletProcessor {
        constructor() {
            super();
            this.chunks = [];
            this.at = 0;
            this.buffered = 0;
            this.start = 0.1;
            this.playing = false;
            this.fadeIn = FADE;
            this.trimming = false;
            this.dry = 0;
            this.quiet = false;
            this.hold = false;
            this.fading = false;
            this.sum = 0;
            this.quanta = 0;
            this.since = 0;
            this.feed = null;
            this.port.onmessage = (e) => {
                this.feed = e.data.feed;
                this.feed.onmessage = (m) => this.add(m.data);
            };
        }

        add(data) {
            if (data.flush) {
                this.chunks = [];
                this.at = 0;
                this.buffered = 0;
                this.playing = false;
                return;
            }
            if (data.start !== undefined) {
                this.start = data.start;
                return;
            }
            if (data.quiet !== undefined) {
                this.quiet = data.quiet;
                return;
            }
            if (data.hold !== undefined) {
                this.fading = data.hold && !this.hold && this.playing;
                if (!data.hold && this.hold) {
                    this.playing = false;
                }
                this.hold = data.hold;
                return;
            }
            this.chunks.push(data);
            this.buffered += data.length >> 1;
            if (this.buffered > LIMIT * sampleRate) {
                this.trimming = true;
            }
        }

        trim() {
            const keep = Math.round((this.start + OVER) * sampleRate);
            while (this.buffered > keep && this.chunks.length) {
                const c = this.chunks[0];
                const n = c.length >> 1;
                const take = Math.min(n - this.at, this.buffered - keep);
                this.at += take;
                this.buffered -= take;
                if (this.at === n) {
                    this.chunks.shift();
                    this.at = 0;
                }
            }
        }

        take(left, right, len) {
            let i = 0;
            while (i < len && this.chunks.length) {
                const c = this.chunks[0];
                const n = c.length >> 1;
                const take = Math.min(len - i, n - this.at);
                left.set(c.subarray(this.at, this.at + take), i);
                right.set(c.subarray(n + this.at, n + this.at + take), i);
                i += take;
                this.at += take;
                this.buffered -= take;
                if (this.at === n) {
                    this.chunks.shift();
                    this.at = 0;
                }
            }
            return i;
        }

        process(inputs, outputs) {
            const out = outputs[0];
            const left = out[0];
            const right = out[1] || out[0];
            const len = left.length;
            this.sum += this.buffered;
            this.quanta++;
            this.since += len;
            if (this.feed && this.since >= REPORT * sampleRate) {
                this.feed.postMessage({ buffered: this.sum / this.quanta, dry: this.dry });
                this.since = 0;
                this.sum = 0;
                this.quanta = 0;
            }
            if (this.hold && !this.fading) {
                return true;
            }
            if (!this.playing && !this.hold) {
                if (this.buffered < (this.start + OVER) * sampleRate) {
                    return true;
                }
                this.trim();
                this.trimming = false;
                this.playing = true;
                this.fadeIn = 0;
            }
            const got = this.take(left, right, len);
            for (let i = 0; this.fadeIn < FADE && i < got; i++, this.fadeIn++) {
                const g = this.fadeIn / FADE;
                left[i] *= g;
                right[i] *= g;
            }
            const ran = got < len;
            if (ran || this.trimming || this.fading) {
                const n = Math.min(got, FADE);
                for (let i = 0; i < n; i++) {
                    const g = 1 - (i + 1) / n;
                    left[got - n + i] *= g;
                    right[got - n + i] *= g;
                }
                this.fadeIn = 0;
            }
            if (this.fading) {
                this.fading = false;
            } else if (this.trimming) {
                this.trimming = false;
                this.trim();
            } else if (ran) {
                this.playing = false;
                if (!this.quiet) {
                    this.dry++;
                }
            }
            return true;
        }
    }

    registerProcessor('retro-sound', Sound);
}());

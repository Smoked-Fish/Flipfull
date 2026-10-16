'use strict';

(function () {
    class Sound extends AudioWorkletProcessor {
        constructor() {
            super();
            this.chunks = [];
            this.at = 0;
            this.feed = null;
            this.port.onmessage = (e) => {
                this.feed = e.data.feed;
                this.feed.onmessage = (m) => this.chunks.push(m.data);
            };
        }

        process(inputs, outputs) {
            const out = outputs[0];
            const left = out[0];
            const right = out[1] || out[0];
            let i = 0;
            while (i < left.length && this.chunks.length) {
                const c = this.chunks[0];
                const n = c.length >> 1;
                const take = Math.min(left.length - i, n - this.at);
                left.set(c.subarray(this.at, this.at + take), i);
                right.set(c.subarray(n + this.at, n + this.at + take), i);
                i += take;
                this.at += take;
                if (this.at === n) {
                    this.chunks.shift();
                    this.at = 0;
                }
            }
            return true;
        }
    }

    registerProcessor('retro-sound', Sound);
}());

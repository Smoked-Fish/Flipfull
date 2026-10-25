'use strict';

(function (scope) {
    const HEADER = 32;

    class Splitter {
        constructor(memory, message) {
            this.memory = memory;
            this.message = message;
            this.head = new Uint8Array(4);
            this.have = 0;
            this.into = null;
            this.got = 0;
        }

        push(piece) {
            let at = 0;
            while (at < piece.length) {
                if (!this.into) {
                    const n = Math.min(4 - this.have, piece.length - at);
                    this.head.set(piece.subarray(at, at + n), this.have);
                    this.have += n;
                    at += n;
                    if (this.have < 4) {
                        return;
                    }
                    this.have = 0;
                    const h = this.head;
                    const size = (h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)) >>> 0;
                    this.into = new Uint8Array(this.memory(size), 0, size);
                    this.got = 0;
                }
                const n = Math.min(this.into.length - this.got, piece.length - at);
                this.into.set(piece.subarray(at, at + n), this.got);
                this.got += n;
                at += n;
                if (this.got === this.into.length) {
                    const whole = this.into;
                    this.into = null;
                    this.message(whole.buffer);
                }
            }
        }
    }

    scope.Wire = {
        HEADER,
        KIND_PICTURE: 1,
        PAUSED: 2,
        HOLD: 4,
        LEAD_MS: 9.5,

        Splitter,

        picture(buffer, h) {
            const h16 = new Uint16Array(buffer, 0, 16);
            const h32 = new Uint32Array(buffer, 0, 8);
            h.kind = h16[0] & 0xff;
            h.flags = h16[0] >> 8;
            h.width = h16[1];
            h.height = h16[2];
            h.top = h16[3];
            h.rows = h16[4];
            h.frames = h16[5];
            h.samples = h32[3];
            h.work = h32[4];
            h.sent = h32[5];
            h.due = h32[6] + h32[7] * 4294967296;
            return h;
        },

        rows(buffer, h) {
            return new Uint16Array(buffer, HEADER, h.width * h.rows);
        },

        sound(buffer, h) {
            const at = HEADER + h.width * h.rows * 2;
            return new Float32Array(buffer.slice(at, at + h.samples * 8));
        },

        play(url, session, rate, grid) {
            const o = grid ? { session, rate, tick: grid.tick, period: grid.period } : { session, rate };
            return `${url.replace(/^ws:/, 'http:')}/play?o=${encodeURIComponent(JSON.stringify(o))}`;
        },

        keys(bits) {
            return JSON.stringify({ keys: bits });
        },
        fast(on) {
            return JSON.stringify({ fast: on });
        },
        pause(session) {
            return JSON.stringify({ pause: session });
        },
        sync(grid, leads, sound) {
            return JSON.stringify({ sync: { tick: grid.tick, period: grid.period, leads, sound } });
        },
    };
}(self));

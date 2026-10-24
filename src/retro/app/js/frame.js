'use strict';

self.Frame = {
    HEADER: 32,
    KIND_FRAME: 1,
    PAUSED: 2,
    HOLD: 4,

    read(buffer, h) {
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
};

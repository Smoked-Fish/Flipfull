'use strict';

(function (scope) {
    const KIND_FRAME = 1;
    const PAUSED = 2;
    const HEADER = 24;
    // buffers go back and forth with the screen worker so there's no garbage
    const BUFFER = 128 * 1024;
    const CHUNK = 64 * 1024;

    let socket = null;
    let url = null;
    let screen = null;
    let sound = null;
    let session = 0;
    let playing = false;
    let pausing = false;
    let options = {};
    let monitor = false;
    let c = counts();
    let since = 0;
    const spare = [];

    function counts() {
        return { messages: 0, frames: 0, work: 0, tripMin: Infinity, tripMax: -Infinity };
    }

    function buffer(size) {
        return size <= BUFFER ? spare.pop() || new ArrayBuffer(BUFFER) : new ArrayBuffer(size);
    }

    function post(message) {
        scope.postMessage(message);
    }

    function send(message) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(message));
        }
    }

    function connect() {
        if (socket || !url) {
            return;
        }
        const s = new WebSocket(url);
        socket = s;
        s.onopen = () => {
            if (playing) {
                start();
            }
        };
        s.onclose = () => {
            if (socket !== s) {
                return;
            }
            socket = null;
            const was = playing;
            stopped();
            post({ closed: true, playing: was });
        };
    }

    function stopped() {
        playing = false;
        if (pausing) {
            pausing = false;
            post({ paused: true });
        }
    }

    function start() {
        session++;
        const s = session;
        const asked = Object.assign({ session }, options);
        c = counts();
        since = performance.now();
        if (sound) {
            sound.postMessage({ hold: false });
        }
        fetch(`${url.replace(/^ws:/, 'http:')}/play?o=${encodeURIComponent(JSON.stringify(asked))}`, { cache: 'no-store' })
            .then((response) => read(s, response))
            .catch(() => {})
            .then(() => ended(s));
    }

    async function read(s, response) {
        let reader = null;
        let chunk = null;
        try {
            reader = response.body.getReader({ mode: 'byob' });
            chunk = new Uint8Array(CHUNK);
        } catch (e) {
            reader = response.body.getReader();
        }
        const head = new Uint8Array(4);
        let have = 0;
        let message = null;
        let got = 0;
        for (;;) {
            const result = await (chunk ? reader.read(chunk) : reader.read());
            if (result.done) {
                return;
            }
            const value = result.value;
            if (chunk) {
                chunk = new Uint8Array(value.buffer);
            }
            let at = 0;
            while (at < value.length) {
                if (!message) {
                    const n = Math.min(4 - have, value.length - at);
                    head.set(value.subarray(at, at + n), have);
                    have += n;
                    at += n;
                    if (have < 4) {
                        break;
                    }
                    have = 0;
                    const size = (head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24)) >>> 0;
                    message = new Uint8Array(buffer(size), 0, size);
                    got = 0;
                }
                const n = Math.min(message.length - got, value.length - at);
                message.set(value.subarray(at, at + n), got);
                got += n;
                at += n;
                if (got === message.length) {
                    frame(message.buffer, s);
                    message = null;
                }
            }
        }
    }

    function ended(s) {
        if (s !== session || (!playing && !pausing)) {
            return;
        }
        const was = playing;
        stopped();
        if (was) {
            post({ closed: true, playing: true });
        }
    }

    function frame(data, s) {
        const h16 = new Uint16Array(data, 0, HEADER >> 1);
        const h32 = new Uint32Array(data, 0, HEADER >> 2);
        const flags = h16[0] >> 8;
        if ((h16[0] & 0xff) !== KIND_FRAME || s !== session) {
            spare.push(data);
            if (flags & PAUSED) {
                post({ paused: true });
            }
            return;
        }
        if (flags & PAUSED) {
            spare.push(data);
            screen.postMessage({ last: true });
            stopped();
            return;
        }
        const samples = h32[3];
        if (samples && sound) {
            const at = HEADER + h16[1] * h16[4] * 2;
            const pcm = data.slice(at, at + samples * 8);
            sound.postMessage(new Float32Array(pcm), [pcm]);
        }
        const trip = performance.now() - h32[5] / 1000;
        c.tripMin = Math.min(c.tripMin, trip);
        c.tripMax = Math.max(c.tripMax, trip);
        c.messages++;
        c.frames += h16[5];
        c.work += h32[4];
        screen.postMessage({ frame: data }, [data]);
    }

    function fromScreen(m) {
        if (m.spare) {
            if (m.spare.byteLength === BUFFER && spare.length < 16) {
                spare.push(m.spare);
            }
        } else if (m.stats) {
            if (monitor) {
                const secs = (performance.now() - since) / 1000;
                since = performance.now();
                post({
                    stats: Object.assign(m.stats, {
                        fps: c.frames / secs,
                        work: c.frames ? c.work / c.frames / 1000 : 0,
                        jitter: c.tripMax - c.tripMin,
                    }),
                });
                c = counts();
            }
        } else if (m.failed) {
            post(m);
        }
    }

    scope.onmessage = (e) => {
        const m = e.data;
        if (m.canvas) {
            screen = new Worker('screen.js');
            screen.onmessage = (s) => fromScreen(s.data);
            screen.postMessage({ canvas: m.canvas }, [m.canvas]);
        } else if (m.sound) {
            sound = m.sound;
        } else if (m.connect) {
            if (m.connect !== url && socket) {
                const old = socket;
                socket = null;
                old.close();
            }
            url = m.connect;
            connect();
        } else if (m.open) {
            screen.postMessage(m);
            if (sound) {
                sound.postMessage({ flush: true });
            }
        } else if (m.play) {
            options = m.play;
            playing = true;
            pausing = false;
            if (socket && socket.readyState === WebSocket.OPEN) {
                start();
            } else {
                connect();
            }
        } else if (m.pause) {
            if (sound) {
                sound.postMessage({ hold: true });
            }
            const was = playing;
            if (socket && socket.readyState === WebSocket.OPEN && was) {
                pausing = true;
                send({ pause: session });
            } else {
                stopped();
                post({ paused: true });
            }
        } else if (m.keys !== undefined) {
            send({ keys: m.keys });
        } else if (m.fast !== undefined) {
            send({ fast: m.fast });
        } else if (m.monitor !== undefined) {
            monitor = m.monitor;
            c = counts();
            since = performance.now();
            screen.postMessage({ monitor });
        }
    };
}(self));

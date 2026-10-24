'use strict';

(function (scope) {
    importScripts('frame.js');
    const { Frame } = scope;
    // buffers go back and forth with the screen worker so there's no garbage
    const BUFFER = 128 * 1024;
    const CHUNK = 64 * 1024;
    const STATS_EVERY = 1000;

    let socket = null;
    let url = null;
    let screen = null;
    let sound = null;
    let rate = 0;
    let session = 0;
    let playing = false;
    let pausing = false;
    let options = {};
    let grid = null;
    let buffered = 0;
    let dry = 0;
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
        screen.postMessage({ playing: false });
        if (pausing) {
            pausing = false;
            post({ paused: true });
        }
    }

    function start() {
        session++;
        const s = session;
        const asked = Object.assign({ session, rate }, grid);
        c = counts();
        since = performance.now();
        screen.postMessage({ playing: true });
        if (sound) {
            sound.postMessage({ start: options.latency / 1000 });
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

    const header = {};

    function frame(data, s) {
        const h = Frame.read(data, header);
        if (h.kind !== Frame.KIND_FRAME || s !== session) {
            spare.push(data);
            if (h.flags & Frame.PAUSED) {
                post({ paused: true });
            }
            return;
        }
        if (h.flags & Frame.PAUSED) {
            spare.push(data);
            screen.postMessage({ last: true });
            stopped();
            return;
        }
        if (h.samples && sound) {
            const at = Frame.HEADER + h.width * h.rows * 2;
            const pcm = data.slice(at, at + h.samples * 8);
            sound.postMessage(new Float32Array(pcm), [pcm]);
        }
        const trip = performance.now() - h.sent / 1000;
        c.tripMin = Math.min(c.tripMin, trip);
        c.tripMax = Math.max(c.tripMax, trip);
        c.messages++;
        c.frames += h.frames;
        c.work += h.work;
        screen.postMessage({ frame: data }, [data]);
    }

    function fromScreen(m) {
        if (m.spare) {
            if (m.spare.byteLength === BUFFER && spare.length < 16) {
                spare.push(m.spare);
            }
        } else if (m.grid) {
            grid = m.grid;
        } else if (m.sync) {
            if (playing) {
                send({ sync: Object.assign(m.sync, { sound: buffered }) });
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
                        sound: rate ? (buffered * 1000) / rate : -1,
                        dry,
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
            rate = m.rate;
            sound.onmessage = (r) => {
                buffered = r.data.buffered;
                dry = r.data.dry;
            };
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
            if (sound) {
                sound.postMessage({ quiet: m.fast });
            }
        } else if (m.monitor !== undefined) {
            monitor = m.monitor;
            c = counts();
            since = performance.now();
            screen.postMessage({ monitor: monitor });
        }
    };
}(self));

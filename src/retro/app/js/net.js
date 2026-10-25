'use strict';

(function (scope) {
    importScripts('wire.js');
    const { Wire } = scope;
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

    function send(text) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(text);
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
        c = counts();
        since = performance.now();
        screen.postMessage({ playing: true });
        if (sound) {
            sound.postMessage({ start: options.latency / 1000 });
            sound.postMessage({ hold: false });
        }
        fetch(Wire.play(url, s, rate, grid), { cache: 'no-store' })
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
        const splitter = new Wire.Splitter(buffer, (data) => picture(data, s));
        for (;;) {
            const result = await (chunk ? reader.read(chunk) : reader.read());
            if (result.done) {
                return;
            }
            if (chunk) {
                chunk = new Uint8Array(result.value.buffer);
            }
            splitter.push(result.value);
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

    function picture(data, s) {
        const h = Wire.picture(data, header);
        if (h.kind !== Wire.KIND_PICTURE || s !== session) {
            spare.push(data);
            if (h.flags & Wire.PAUSED) {
                post({ paused: true });
            }
            return;
        }
        if (h.flags & Wire.PAUSED) {
            spare.push(data);
            screen.postMessage({ last: true });
            stopped();
            return;
        }
        if (h.samples && sound) {
            const pcm = Wire.sound(data, h);
            sound.postMessage(pcm, [pcm.buffer]);
        }
        const trip = performance.now() - h.sent / 1000;
        c.tripMin = Math.min(c.tripMin, trip);
        c.tripMax = Math.max(c.tripMax, trip);
        c.messages++;
        c.frames += h.frames;
        c.work += h.work;
        screen.postMessage({ picture: data }, [data]);
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
                send(Wire.sync(m.sync.grid, m.sync.leads, buffered));
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
                send(Wire.pause(session));
            } else {
                stopped();
                post({ paused: true });
            }
        } else if (m.keys !== undefined) {
            send(Wire.keys(m.keys));
        } else if (m.fast !== undefined) {
            send(Wire.fast(m.fast));
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

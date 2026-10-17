'use strict';

(function (scope) {
    const KIND_FRAME = 1;
    const PAUSED = 2;
    const HEADER = 16;

    let socket = null;
    let url = null;
    let screen = null;
    let sound = null;
    let playing = false;
    let pausing = false;
    let monitor = false;
    let frames = 0;
    let since = 0;

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
        s.binaryType = 'arraybuffer';
        socket = s;
        s.onopen = () => {
            if (playing) {
                send({ play: true });
            }
        };
        s.onmessage = (e) => frame(e.data);
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

    function frame(data) {
        const h16 = new Uint16Array(data, 0, HEADER >> 1);
        const h32 = new Uint32Array(data, 0, HEADER >> 2);
        if ((h16[0] & 0xff) !== KIND_FRAME) {
            return;
        }
        if ((h16[0] >> 8) & PAUSED) {
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
        frames += h16[5];
        screen.postMessage({ frame: data }, [data]);
    }

    function fromScreen(m) {
        if (m.stats) {
            if (monitor) {
                const secs = (performance.now() - since) / 1000;
                since = performance.now();
                post({ stats: Object.assign(m.stats, { fps: frames / secs }) });
                frames = 0;
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
            playing = true;
            pausing = false;
            if (sound) {
                sound.postMessage({ hold: false });
            }
            if (socket && socket.readyState === WebSocket.OPEN) {
                send({ play: true });
            } else {
                connect();
            }
        } else if (m.pause) {
            if (sound) {
                sound.postMessage({ hold: true });
            }
            if (socket && socket.readyState === WebSocket.OPEN && playing) {
                pausing = true;
                send({ pause: true });
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
            frames = 0;
            since = performance.now();
            screen.postMessage({ monitor });
        }
    };
}(self));

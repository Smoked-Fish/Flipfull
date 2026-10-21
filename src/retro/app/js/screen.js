'use strict';

(function (scope) {
    const HEADER = 32;
    const HOLD = 4;
    const SYNC_EVERY = 250;
    const STATS_EVERY = 1000;
    const IDLE = 30;
    // raf times are whole ms here, average them
    const SMOOTH = 0.05;
    const IN_TIME = 10;

    function counts() {
        return { shown: 0, held: 0, late: 0, ticks: 0, busy: 0, lead: null };
    }

    class Screen {
        constructor(canvas) {
            this.canvas = canvas;
            this.width = 0;
            this.height = 0;
            this.changed = false;
            const gl = canvas.getContext('webgl', {
                alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
            });
            if (!gl) {
                throw new Error('no WebGL for the screen');
            }
            const shader = (type, source) => {
                const s = gl.createShader(type);
                gl.shaderSource(s, source);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                    throw new Error(gl.getShaderInfoLog(s));
                }
                return s;
            };
            const program = gl.createProgram();
            gl.attachShader(program, shader(gl.VERTEX_SHADER, `
        attribute vec2 p;
        varying vec2 uv;
        void main() {
          uv = vec2(p.x + 1.0, 1.0 - p.y) * 0.5;
          gl_Position = vec4(p, 0.0, 1.0);
        }`));
            gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
        precision highp float;
        uniform sampler2D t;
        uniform vec2 size;
        uniform vec2 perPixel;
        varying vec2 uv;
        void main() {
          vec2 p = uv * size;
          vec2 seam = floor(p + 0.5);
          p = seam + clamp((p - seam) / perPixel, -0.5, 0.5);
          gl_FragColor = texture2D(t, p / size);
        }`));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                throw new Error(gl.getProgramInfoLog(program));
            }
            gl.useProgram(program);
            gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
            const p = gl.getAttribLocation(program, 'p');
            gl.enableVertexAttribArray(p);
            gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
            gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
            this.gl = gl;
            this.size = gl.getUniformLocation(program, 'size');
            this.perPixel = gl.getUniformLocation(program, 'perPixel');
        }

        clear(width, height, outWidth, outHeight) {
            const gl = this.gl;
            this.width = width;
            this.height = height;
            this.canvas.width = outWidth;
            this.canvas.height = outHeight;
            gl.viewport(0, 0, outWidth, outHeight);
            gl.uniform2f(this.size, width, height);
            gl.uniform2f(this.perPixel, width / outWidth, height / outHeight);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, width, height, 0, gl.RGB, gl.UNSIGNED_SHORT_5_6_5,
                new Uint16Array(width * height));
            this.changed = true;
        }

        rows(width, height, top, rows, buffer) {
            if (width !== this.width || height !== this.height) {
                this.clear(width, height, this.canvas.width, this.canvas.height);
            }
            if (rows) {
                const gl = this.gl;
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, top, width, rows, gl.RGB, gl.UNSIGNED_SHORT_5_6_5,
                    new Uint16Array(buffer, HEADER, width * rows));
                this.changed = true;
            }
        }

        draw() {
            this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
            this.changed = false;
        }
    }

    let screen = null;
    const net = scope;
    let playing = false;
    let looping = false;
    let idle = 0;
    let period = 1000 / 60;
    let phase = 0;
    let last = 0;
    let span = 0;
    let refreshes = 0;
    let synced = 0;
    let leads = [];
    let monitor = false;
    let c = counts();
    let since = 0;

    function loop() {
        idle = 0;
        if (!looping) {
            looping = true;
            requestAnimationFrame(tick);
        }
    }

    function show(buffer) {
        const h16 = new Uint16Array(buffer, 0, HEADER >> 1);
        const h32 = new Uint32Array(buffer, 0, HEADER >> 2);
        screen.rows(h16[1], h16[2], h16[3], h16[4], buffer);
        if ((h16[0] >> 8) & HOLD) {
            c.held++;
        } else if (screen.changed) {
            screen.draw();
            c.shown++;
            const due = h32[6] + h32[7] * 4294967296;
            if (due) {
                const ahead = due / 1000 - (performance.timeOrigin + performance.now());
                leads.push(Math.round(ahead * 1000));
                c.lead = c.lead === null ? ahead : Math.min(c.lead, ahead);
                if (ahead < IN_TIME) {
                    c.late++;
                }
            }
        }
        net.postMessage({ spare: buffer }, [buffer]);
    }

    function tick(t) {
        const t0 = performance.now();
        const at = performance.timeOrigin + t;
        c.ticks++;
        if (last) {
            const dt = t - last;
            const n = Math.max(1, Math.round(dt / period));
            if (n <= 4) {
                span += dt;
                refreshes += n;
                if (refreshes >= 30) {
                    period = span / refreshes;
                }
            }
            const expected = phase + Math.round((at - phase) / period) * period;
            phase = expected + (at - expected) * SMOOTH;
        } else {
            phase = at;
        }
        last = t;
        if (!playing && ++idle > IDLE) {
            looping = false;
            last = 0;
            return;
        }
        if (t - synced >= SYNC_EVERY) {
            synced = t;
            const grid = { tick: Math.round(phase * 1000), period: Math.round(period * 1000) };
            net.postMessage({ grid });
            if (playing) {
                net.postMessage({ sync: Object.assign(grid, { leads }) });
                leads = [];
            }
        }
        c.busy += performance.now() - t0;
        if (monitor && t - since >= STATS_EVERY) {
            const secs = (t - since) / 1000;
            net.postMessage({
                stats: {
                    shown: c.shown / secs,
                    held: c.held / secs,
                    late: c.late / secs,
                    refresh: c.ticks / secs,
                    hz: 1000 / period,
                    lead: c.lead,
                    busy: c.busy / secs,
                },
            });
            c = counts();
            since = t;
        }
        requestAnimationFrame(tick);
    }

    function fromNet(m) {
        if (m.frame) {
            show(m.frame);
        } else if (m.last) {
            if (screen.changed) {
                screen.draw();
            }
        } else if (m.playing !== undefined) {
            playing = m.playing;
            if (playing) {
                span = 0;
                refreshes = 0;
                leads = [];
                c = counts();
                since = performance.now();
                loop();
            }
        } else if (m.monitor !== undefined) {
            monitor = m.monitor;
            c = counts();
            since = performance.now();
        }
    }

    scope.onmessage = (e) => {
        const m = e.data;
        if (m.canvas) {
            try {
                screen = new Screen(m.canvas);
            } catch (err) {
                net.postMessage({ failed: err.message });
            }
        } else if (m.open) {
            screen.clear(m.open.width, m.open.height, m.open.outWidth, m.open.outHeight);
            screen.draw();
            loop();
        } else {
            fromNet(m);
        }
    };
}(self));

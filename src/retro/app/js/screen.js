'use strict';

(function (scope) {
    const HEADER = 8;
    const STATS_EVERY = 1000;

    class Screen {
        constructor(canvas) {
            this.canvas = canvas;
            this.width = 0;
            this.height = 0;
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
        }

        draw(width, height, buffer) {
            if (width !== this.width || height !== this.height) {
                this.clear(width, height, this.canvas.width, this.canvas.height);
            }
            const gl = this.gl;
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGB, gl.UNSIGNED_SHORT_5_6_5,
                new Uint16Array(buffer, HEADER, width * height));
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
    }

    let screen = null;
    let socket = null;
    let url = null;
    let sound = null;
    let playing = false;
    let monitor = false;
    let frames = 0;
    let since = 0;

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
            if (playing) {
                playing = false;
                scope.postMessage({ closed: true });
            }
        };
    }

    function frame(data) {
        const h16 = new Uint16Array(data, 0, 2);
        const samples = new Uint32Array(data, 4, 1)[0];
        const width = h16[0];
        const height = h16[1];
        screen.draw(width, height, data);
        frames++;
        if (samples && sound) {
            const pcm = new Int16Array(data, HEADER + width * height * 2, samples * 2);
            const out = new Float32Array(samples * 2);
            for (let i = 0; i < samples; i++) {
                out[i] = pcm[2 * i] / 32768;
                out[samples + i] = pcm[2 * i + 1] / 32768;
            }
            sound.postMessage(out, [out.buffer]);
        }
        const now = performance.now();
        if (monitor && now - since >= STATS_EVERY) {
            scope.postMessage({ stats: { fps: (frames * 1000) / (now - since) } });
            frames = 0;
            since = now;
        }
    }

    scope.onmessage = (e) => {
        const m = e.data;
        if (m.canvas) {
            try {
                screen = new Screen(m.canvas);
            } catch (err) {
                scope.postMessage({ failed: err.message });
            }
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
            screen.clear(m.open.width, m.open.height, m.open.outWidth, m.open.outHeight);
        } else if (m.play) {
            playing = true;
            frames = 0;
            since = performance.now();
            if (socket && socket.readyState === WebSocket.OPEN) {
                send({ play: true });
            } else {
                connect();
            }
        } else if (m.pause) {
            playing = false;
            send({ pause: true });
        } else if (m.keys !== undefined) {
            send({ keys: m.keys });
        } else if (m.monitor !== undefined) {
            monitor = m.monitor;
            frames = 0;
            since = performance.now();
        }
    };
}(self));

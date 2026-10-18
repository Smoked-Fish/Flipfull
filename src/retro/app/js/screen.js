'use strict';

(function (scope) {
    const HEADER = 24;
    const STATS_EVERY = 1000;

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
    let monitor = null;
    let shown = 0;
    let since = 0;

    function show(buffer) {
        const h16 = new Uint16Array(buffer, 0, HEADER >> 1);
        screen.rows(h16[1], h16[2], h16[3], h16[4], buffer);
        if (screen.changed) {
            screen.draw();
            shown++;
        }
        net.postMessage({ spare: buffer }, [buffer]);
    }

    function stats() {
        const now = performance.now();
        net.postMessage({ stats: { shown: (shown * 1000) / (now - since) } });
        shown = 0;
        since = now;
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
        } else if (m.frame) {
            show(m.frame);
        } else if (m.last) {
            if (screen.changed) {
                screen.draw();
            }
        } else if (m.monitor !== undefined) {
            clearInterval(monitor);
            monitor = m.monitor ? setInterval(stats, STATS_EVERY) : null;
            shown = 0;
            since = performance.now();
        }
    };
}(self));

'use strict';

(function () {
    const RATE = 32768;

    class Player {
        constructor(canvas, events) {
            this.canvas = canvas;
            this.events = events;
            this.held = 0;
            this.fastOn = false;
            this.report = null;
            this.waiters = [];
            this.sound = null;
            this.worker = new Worker('js/net.js');
            this.worker.onmessage = (e) => this.message(e.data);
            const offscreen = canvas.transferControlToOffscreen();
            this.worker.postMessage({ canvas: offscreen }, [offscreen]);
            this.ready = this.startSound();
        }

        async startSound() {
            try {
                let ctx;
                try {
                    ctx = new AudioContext({ sampleRate: RATE });
                } catch (e) {
                    ctx = new AudioContext();
                }
                await ctx.audioWorklet.addModule('js/sound.js');
                const node = new AudioWorkletNode(ctx, 'retro-sound', { numberOfInputs: 0, outputChannelCount: [2] });
                node.connect(ctx.destination);
                const channel = new MessageChannel();
                node.port.postMessage({ feed: channel.port1 }, [channel.port1]);
                this.worker.postMessage({ sound: channel.port2, rate: ctx.sampleRate }, [channel.port2]);
                this.sound = ctx;
            } catch (e) {
                console.log(`[retro] no sound: ${e}`);
            }
        }

        // resume() right after suspend() never finishes on this phone, so the context keeps running
        sounding() {
            this.ready.then(() => {
                if (this.sound && this.sound.state !== 'running') {
                    this.sound.resume().catch(() => {});
                }
            });
        }

        message(m) {
            if (m.paused) {
                this.waiters.splice(0).forEach((resolve) => resolve());
            }
            if (m.stats && this.report) {
                this.report(m.stats);
            }
            if (m.failed) {
                this.events.failed(new Error(m.failed));
            }
            if (m.closed && m.playing) {
                const e = new Error("The GBA service closed the game's connection.");
                e.offline = true;
                this.events.failed(e);
            }
        }

        connect(url) {
            this.worker.postMessage({ connect: url });
        }

        open(width, height, outWidth, outHeight) {
            this.canvas.style.width = `${outWidth}px`;
            this.canvas.style.height = `${outHeight}px`;
            this.worker.postMessage({ open: { width, height, outWidth, outHeight } });
        }

        play() {
            this.sounding();
            this.worker.postMessage({ play: true });
        }

        pause() {
            this.fastOn = false;
            return new Promise((resolve) => {
                this.waiters.push(resolve);
                this.worker.postMessage({ pause: true });
            });
        }

        set keys(bits) {
            if (bits !== this.held) {
                this.held = bits;
                this.worker.postMessage({ keys: bits });
            }
        }

        set fast(on) {
            if (on !== this.fastOn) {
                this.fastOn = on;
                this.worker.postMessage({ fast: on });
            }
        }

        set monitor(fn) {
            this.report = fn;
            this.worker.postMessage({ monitor: !!fn });
        }
    }

    window.RetroPlayer = Player;
}());

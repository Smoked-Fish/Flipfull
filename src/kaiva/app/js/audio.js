'use strict';

(function (exports) {
  const RATE = 16000;
  const MAX_MS = 30000;
  const NO_SPEECH_MS = 8000;
  const END_SILENCE_MS = 1300;
  const PREROLL_MS = 350;
  const TAIL_MS = 300;
  const MIN_THRESHOLD = 0.012;
  const CHANNEL_WAIT_MS = 400;

  class Downsampler {
    constructor(inRate) {
      this.ratio = inRate / RATE;
      this.pos = 0;
      this.acc = 0;
      this.n = 0;
    }

    push(input) {
      if (this.ratio === 1) {
        return Float32Array.from(input);
      }
      const out = new Float32Array(Math.ceil(input.length / this.ratio) + 1);
      let k = 0;
      for (let i = 0; i < input.length; i++) {
        this.acc += input[i];
        this.n++;
        this.pos += 1;
        if (this.pos >= this.ratio) {
          out[k++] = this.acc / this.n;
          this.acc = 0;
          this.n = 0;
          this.pos -= this.ratio;
        }
      }
      return out.subarray(0, k);
    }
  }

  function openSource(stream) {
    try {
      const ctx = new AudioContext({ sampleRate: RATE });
      try {
        return { ctx, src: ctx.createMediaStreamSource(stream) };
      } catch (e) {
        ctx.close();
      }
    } catch (e) {}
    const ctx = new AudioContext();
    return { ctx, src: ctx.createMediaStreamSource(stream) };
  }

  function acquireChannel() {
    if (typeof AudioChannelClient === 'undefined') {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let client;
      try {
        client = new AudioChannelClient('normal');
      } catch (e) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => resolve(client), CHANNEL_WAIT_MS);
      client.addEventListener('statechange', () => {
        clearTimeout(timer);
        resolve(client);
      }, { once: true });
      try {
        client.requestChannel();
      } catch (e) {
        clearTimeout(timer);
        resolve(client);
      }
    });
  }

  class Recorder {
    constructor({ onLevel, onSpeech, onEnd }) {
      this.onLevel = onLevel;
      this.onSpeech = onSpeech;
      this.onEnd = onEnd;
      this.chunks = [];
      this.total = 0;
      this.floor = null;
      this.loudRun = 0;
      this.speechStart = -1;
      this.lastLoud = -1;
      this.ended = false;
    }

    async start() {
      this.channel = await acquireChannel();
      if (this.ended) {
        this.release();
        return;
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
      if (this.ended) {
        this.release();
        return;
      }
      const { ctx, src } = openSource(this.stream);
      this.ctx = ctx;
      this.src = src;
      this.down = new Downsampler(ctx.sampleRate);
      this.proc = ctx.createScriptProcessor(2048, 1, 1);
      this.proc.onaudioprocess = (e) => this.onChunk(this.down.push(e.inputBuffer.getChannelData(0)));
      src.connect(this.proc);
      this.proc.connect(ctx.destination);
    }

    onChunk(x) {
      if (this.ended || x.length === 0) {
        return;
      }
      this.chunks.push(x);
      this.total += x.length;

      let sum = 0;
      for (let i = 0; i < x.length; i++) {
        sum += x[i] * x[i];
      }
      const rms = Math.sqrt(sum / x.length);
      this.onLevel(rms);

      if (this.floor === null || rms < this.floor) {
        this.floor = rms;
      } else if (this.speechStart < 0) {
        this.floor = this.floor * 0.98 + rms * 0.02;
      }
      const threshold = Math.max(MIN_THRESHOLD, this.floor * 3);

      if (rms > threshold) {
        this.loudRun++;
        this.lastLoud = this.total;
        if (this.speechStart < 0 && this.loudRun >= 2) {
          this.speechStart = Math.max(0, this.total - 2 * x.length);
          this.onSpeech();
        }
      } else {
        this.loudRun = 0;
      }

      const ms = (n) => (n * 1000) / RATE;
      if (ms(this.total) >= MAX_MS) {
        this.stop();
      } else if (this.speechStart >= 0 && ms(this.total - this.lastLoud) >= END_SILENCE_MS) {
        this.stop();
      } else if (this.speechStart < 0 && ms(this.total) >= NO_SPEECH_MS) {
        this.stop();
      }
    }

    stop(manual = false) {
      if (this.ended) {
        return;
      }
      this.release();

      const all = new Float32Array(this.total);
      let off = 0;
      for (const c of this.chunks) {
        all.set(c, off);
        off += c.length;
      }
      this.chunks = [];

      const heard = this.speechStart >= 0;
      if (!heard && !(manual && all.length >= RATE / 2)) {
        this.onEnd(null);
        return;
      }
      let from = 0;
      let to = all.length;
      if (heard) {
        from = Math.max(0, this.speechStart - (PREROLL_MS * RATE) / 1000);
        to = Math.min(all.length, this.lastLoud + (TAIL_MS * RATE) / 1000);
      }
      const clip = all.subarray(from, to);
      const pcm = new Int16Array(Math.max(clip.length, RATE));
      for (let i = 0; i < clip.length; i++) {
        const s = Math.max(-1, Math.min(1, clip[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.onEnd(pcm);
    }

    release() {
      this.ended = true;
      if (this.proc) {
        this.proc.onaudioprocess = null;
        this.proc.disconnect();
        this.proc = null;
      }
      if (this.src) {
        this.src.disconnect();
        this.src = null;
      }
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      if (this.ctx && this.ctx.state !== 'closed') {
        this.ctx.close();
      }
      if (this.channel) {
        try {
          this.channel.abandonChannel();
        } catch (e) {}
        this.channel = null;
      }
    }
  }

  exports.Recorder = Recorder;
})(window.Mic = {});

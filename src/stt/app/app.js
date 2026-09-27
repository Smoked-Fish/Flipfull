'use strict';

const SERVICE = 'http://127.0.0.1:8321';
const RATE = 16000;
const MAX_MS = 30000;
const NO_SPEECH_MS = 8000;
const END_SILENCE_MS = 1300;
const PREROLL_MS = 350;
const TAIL_MS = 300;
const MIN_THRESHOLD = 0.012;
const TIMEOUT_MS = 45000;
const KEEP_WARM_MS = 5000;

const isActivity = location.hash === '#activity';

const el = {
  body: document.body,
  status: document.getElementById('status'),
  text: document.getElementById('text'),
  orb: document.getElementById('orb'),
  left: document.getElementById('sk-left'),
  center: document.getElementById('sk-center'),
  right: document.getElementById('sk-right'),
};

let state = 'starting';
let recorder = null;
let request = null;
let resultText = '';
let done = false;
let keepWarm = null;

function setState(next, status, keys) {
  console.log(`Dictate: ${next}${status ? ` (${status})` : ''}`);
  state = next;
  if (next === 'listening') {
    keepWarm = keepWarm || setInterval(warmup, KEEP_WARM_MS);
  } else {
    clearInterval(keepWarm);
    keepWarm = null;
  }
  el.body.dataset.state = next;
  if (status !== undefined) {
    el.status.textContent = status;
  }
  const [l, c, r] = keys || ['', '', ''];
  el.left.textContent = l;
  el.center.textContent = c;
  el.right.textContent = r;
}

function setLevel(rms) {
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  const t = Math.min(1, Math.max(0, (db + 60) / 50));
  el.orb.style.setProperty('--level', (1 + t * 0.6).toFixed(3));
}

function showError(message) {
  setState('error', message, ['Retry', '', isActivity ? 'Cancel' : 'Exit']);
}

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

class Recorder {
  constructor(onLevel, onEnd) {
    this.onLevel = onLevel;
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
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
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
    }
    if (this.src) {
      this.src.disconnect();
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close();
    }
  }
}

function warmup() {
  return fetch(`${SERVICE}/warmup`, { method: 'POST' }).then(
    (res) => res.ok,
    () => false
  );
}

async function transcribe(pcm) {
  const ctrl = new AbortController();
  request = ctrl;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVICE}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pcm.buffer,
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json.text;
  } catch (e) {
    throw timedOut ? new Error('took too long') : e;
  } finally {
    clearTimeout(timer);
  }
}

async function listen() {
  cancelWork();
  resultText = '';
  el.text.textContent = '';
  setLevel(0);
  setState('starting', 'Starting…', ['Cancel', '', '']);

  const serviceUp = warmup();
  recorder = new Recorder(setLevel, onClip);
  try {
    await recorder.start();
  } catch (e) {
    console.error('Dictate: getUserMedia failed', e);
    showError('Microphone unavailable');
    return;
  }
  if (state !== 'starting') {
    recorder.release();
    return;
  }
  setState('listening', 'Listening…', ['Cancel', 'Done', '']);

  if (!(await serviceUp) && state === 'listening') {
    recorder.release();
    showError('Speech service is not running');
  }
}

async function onClip(pcm) {
  recorder = null;
  setLevel(0);
  if (!pcm) {
    showError("Didn't hear anything");
    return;
  }
  setState('transcribing', 'Transcribing…', ['Cancel', '', '']);
  try {
    const text = await transcribe(pcm);
    request = null;
    if (state !== 'transcribing') {
      return;
    }
    if (!text) {
      showError("Didn't catch that");
      return;
    }
    resultText = text;
    el.text.textContent = text;
    el.text.scrollTop = 0;
    setState('result', undefined, ['Retry', isActivity ? 'Insert' : 'Copy', isActivity ? 'Cancel' : 'Exit']);
  } catch (e) {
    request = null;
    if (e.name !== 'AbortError') {
      console.error('Dictate: transcription failed', e);
      showError(e instanceof TypeError ? 'Speech service is not running' : `Failed: ${e.message}`);
    }
  }
}

function cancelWork() {
  if (recorder) {
    recorder.release();
    recorder = null;
  }
  if (request) {
    request.abort();
    request = null;
  }
}

function toWorker(msg) {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (sw) {
    sw.postMessage(msg);
  }
}

function leave(result) {
  cancelWork();
  if (isActivity && !done) {
    done = true;
    toWorker(result === undefined ? { type: 'cancel' } : { type: 'result', text: result });
  }
  window.close();
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const range = document.createRange();
    range.selectNodeContents(el.text);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    sel.removeAllRanges();
  }
  el.center.textContent = 'Copied';
}

function onKey(e) {
  const key = e.key;
  const back = key === 'Backspace' || key === 'GoBack' || key === 'BrowserBack';
  const ok = key === 'Enter' || key === 'MicrophoneToggle';
  if (back || ok || key === 'SoftLeft' || key === 'SoftRight' || key.startsWith('Arrow')) {
    e.preventDefault();
  }

  switch (state) {
    case 'starting':
    case 'transcribing':
      if (back || key === 'SoftLeft') {
        leave();
      }
      break;
    case 'listening':
      if (ok) {
        recorder.stop(true);
      } else if (back || key === 'SoftLeft') {
        leave();
      }
      break;
    case 'result':
      if (ok) {
        if (isActivity) {
          leave(resultText);
        } else {
          copy(resultText);
        }
      } else if (key === 'SoftLeft') {
        listen();
      } else if (back || key === 'SoftRight') {
        leave();
      } else if (key === 'ArrowDown' || key === 'ArrowUp') {
        el.text.scrollBy(0, key === 'ArrowDown' ? 40 : -40);
      }
      break;
    case 'error':
      if (ok || key === 'SoftLeft') {
        listen();
      } else if (back || key === 'SoftRight') {
        leave();
      }
      break;
  }
}

window.addEventListener('keydown', onKey);

if (isActivity) {
  setInterval(() => toWorker({ type: 'keepalive' }), 5000);
  toWorker({ type: 'hello' });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state !== 'starting') {
      leave();
    }
  });
}

window.addEventListener('pagehide', () => {
  cancelWork();
  if (isActivity && !done) {
    done = true;
    toWorker({ type: 'cancel' });
  }
});

if (!isActivity && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

listen();

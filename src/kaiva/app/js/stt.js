'use strict';

(function (exports) {
  const ONLINE = 'https://kva.data.kaiostech.com/api/stt-openai';
  const TIMEOUT_MS = 45000;
  const CHUNK = 2 * 1024 * 1024;

  let sessionUp = null;

  function speech() {
    return window.FlipfullSpeech || null;
  }

  function offline(message) {
    const e = new Error(message);
    e.offline = true;
    return e;
  }

  function open() {
    if (!sessionUp) {
      const s = speech();
      sessionUp = s ? s.open().catch(() => false) : Promise.resolve(false);
      sessionUp.then((up) => {
        if (!up) {
          sessionUp = null;
        }
      });
    }
    return sessionUp;
  }

  function close() {
    const s = speech();
    if (sessionUp && s) {
      s.close().catch(() => {});
    }
    sessionUp = null;
  }

  function health() {
    const s = speech();
    return s ? s.health().catch(() => null) : Promise.resolve(null);
  }

  function models() {
    const s = speech();
    return s ? s.models().catch(() => null) : Promise.resolve(null);
  }

  function useModel(file) {
    const s = speech();
    return s ? s.useModel(file) : Promise.reject(offline("Flipfull's speech service didn't load"));
  }

  function deleteModel(file) {
    const s = speech();
    return s ? s.deleteModel(file) : Promise.reject(offline("Flipfull's speech service didn't load"));
  }

  function range(url, from, to) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest({ mozSystem: true });
      xhr.open('GET', url);
      xhr.setRequestHeader('Range', `bytes=${from}-${to}`);
      xhr.responseType = 'arraybuffer';
      xhr.timeout = TIMEOUT_MS;
      xhr.onload = () => {
        if (xhr.status === 206 && xhr.response) {
          resolve(new Uint8Array(xhr.response));
        } else {
          reject(new Error(`the download said HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(offline('no internet connection'));
      xhr.ontimeout = () => reject(new Error('took too long'));
      xhr.send();
    });
  }

  async function download(m, onBytes) {
    const s = speech();
    if (!s) {
      throw offline("Flipfull's speech service didn't load");
    }
    for (let at = m.bytes; at < m.size;) {
      const bytes = await range(m.url, at, Math.min(at + CHUNK, m.size) - 1);
      if (!bytes.length) {
        throw new Error('the download stopped');
      }
      await s.download(m.file, at, bytes);
      at += bytes.length;
      onBytes(at);
    }
  }

  function transcribe(pcm, ctrl) {
    const s = speech();
    if (!s) {
      return Promise.reject(offline("Flipfull's speech service didn't load"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('took too long')), TIMEOUT_MS);
      ctrl.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      });
      s.transcribe(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)).then((json) => {
        clearTimeout(timer);
        resolve((json.text || '').trim());
      }, (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  function wav(pcm) {
    const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const tag = (at, s) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
    tag(0, 'RIFF');
    out.setUint32(4, 36 + pcm.length * 2, true);
    tag(8, 'WAVEfmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 1, true);
    out.setUint32(24, Mic.RATE, true);
    out.setUint32(28, Mic.RATE * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    tag(36, 'data');
    out.setUint32(40, pcm.length * 2, true);
    new Int16Array(out.buffer, 44).set(pcm); // copy the samples as they are
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  function dataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function transcribeOnline(pcm, ctrl) {
    const [mimeType, audio] = (await dataUrl(wav(pcm))).split(',');
    const json = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest({ mozSystem: true });
      xhr.open('POST', ONLINE);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.responseType = 'json';
      xhr.timeout = TIMEOUT_MS;
      xhr.onload = () => {
        if (xhr.status === 200 && xhr.response) {
          resolve(xhr.response);
        } else {
          reject(new Error(`KaiOS's speech service said HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(offline('no internet connection'));
      xhr.ontimeout = () => reject(new Error('took too long'));
      ctrl.signal.addEventListener('abort', () => xhr.abort());
      xhr.send(JSON.stringify({ audio, mimeType }));
    });
    return (json.result || '').trim();
  }

  Object.assign(exports, { open, close, health, models, useModel, deleteModel, download, transcribe, transcribeOnline });
})(window.STT = {});

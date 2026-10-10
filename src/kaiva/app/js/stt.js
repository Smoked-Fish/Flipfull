'use strict';

(function (exports) {
  const TIMEOUT_MS = 45000;

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

  Object.assign(exports, { open, close, health, models, useModel, transcribe });
})(window.STT = {});

'use strict';

(function (exports) {
  const SERVICE = 'http://127.0.0.1:8321';
  const TIMEOUT_MS = 45000;

  function warmup() {
    return fetch(`${SERVICE}/warmup`, { method: 'POST' }).then(
      (res) => res.ok,
      () => false
    );
  }

  function health() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    return fetch(`${SERVICE}/health`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  async function transcribe(pcm, ctrl) {
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
      return (json.text || '').trim();
    } catch (e) {
      throw timedOut ? new Error('took too long') : e;
    } finally {
      clearTimeout(timer);
    }
  }

  Object.assign(exports, { warmup, health, transcribe });
})(window.STT = {});

'use strict';

(function (exports) {
  const SERVICE = 'http://127.0.0.1:8321';
  const TIMEOUT_MS = 45000;

  let session = null;
  let sessionUp = null;

  function open() {
    if (session) {
      return sessionUp;
    }
    const s = new EventSource(`${SERVICE}/session`);
    session = s;
    let opened = false;
    sessionUp = new Promise((resolve) => {
      s.onopen = () => {
        opened = true;
        resolve(true);
      };
      s.onerror = () => {
        if (!opened && session === s) {
          session = null;
          s.close();
          resolve(false);
        }
      };
    });
    return sessionUp;
  }

  function close() {
    if (session) {
      session.close();
      session = null;
    }
  }

  function getJson(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    return fetch(`${SERVICE}${path}`, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .finally(() => clearTimeout(timer));
  }

  function health() {
    return getJson('/health');
  }

  function models() {
    return getJson('/models');
  }

  async function useModel(file) {
    const res = await fetch(`${SERVICE}/model`, { method: 'POST', body: file });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json;
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

  Object.assign(exports, { open, close, health, models, useModel, transcribe });
})(window.STT = {});

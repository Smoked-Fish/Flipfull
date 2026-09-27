self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

let handler = null;
let release = null;
let assistant = null;

function finish() {
  handler = null;
  if (release) {
    release();
    release = null;
  }
}

self.onsystemmessage = (evt) => {
  if (evt.name !== 'activity') {
    return;
  }
  const request = evt.data.webActivityRequestHandler();
  const source = request.source;

  if (source.name === 'voice-assistant') {
    assistant = { data: source.data || {}, at: Date.now() };
    evt.waitUntil(
      clients.openWindow('/index.html#voice-assistant').then(
        (win) => win && win.postMessage({ type: 'assistant', data: assistant.data }),
        (err) => console.error(`KaiVA: openWindow failed: ${err}`)
      )
    );
    return;
  }

  if (source.name !== 'voice-input') {
    return;
  }
  if (handler) {
    handler.postError('superseded');
    finish();
  }
  handler = request;
  evt.waitUntil(
    clients.openWindow('/index.html#voice-input', { disposition: 'inline' }).then(
      (win) => win && win.postMessage({ type: 'activity', source }),
      (err) => console.error(`KaiVA: openWindow failed: ${err}`)
    )
  );
  evt.waitUntil(new Promise((resolve) => { release = resolve; }));
};

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'hello') {
    const url = (event.source && event.source.url) || '';
    if (url.endsWith('#voice-input')) {
      if (handler) {
        event.source.postMessage({ type: 'activity', source: handler.source });
      }
    } else if (assistant && Date.now() - assistant.at < 10000) {
      event.source.postMessage({ type: 'assistant', data: assistant.data });
    }
    return;
  }
  if (data.type === 'keepalive' || !handler) {
    return;
  }
  if (data.type === 'result') {
    handler.postResult(data.text);
  } else if (data.type === 'cancel') {
    handler.postError(data.reason || 'cancelled');
  }
  finish();
});

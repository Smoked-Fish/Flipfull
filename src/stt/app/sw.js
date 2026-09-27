self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

let handler = null;
let release = null;

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
  if (request.source.name === 'voice-assistant') {
    evt.waitUntil(clients.openWindow('/index.html').catch(
      (err) => console.error(`Dictate: openWindow failed: ${err}`)));
    return;
  }
  if (handler) {
    handler.postError('superseded');
    finish();
  }
  handler = request;
  const source = handler.source;

  evt.waitUntil(
    clients.openWindow('/index.html#activity', { disposition: 'inline' }).then(
      (win) => win && win.postMessage({ type: 'activity', source }),
      (err) => console.error(`Dictate: openWindow failed: ${err}`)
    )
  );
  evt.waitUntil(new Promise((resolve) => { release = resolve; }));
};

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'hello') {
    if (handler) {
      event.source.postMessage({ type: 'activity', source: handler.source });
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

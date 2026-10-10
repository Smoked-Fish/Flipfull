'use strict';

let handler = null;
let answered = null;

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.onsystemmessage = (e) => {
  if (e.name !== 'activity') {
    return;
  }
  handler = e.data.webActivityRequestHandler();
  e.waitUntil(self.clients.openWindow('/index.html#activity', { disposition: 'inline' })
    .then((win) => win.postMessage({ source: handler.source })));
  e.waitUntil(new Promise((resolve) => {
    answered = resolve;
  }));
};

self.addEventListener('message', (e) => {
  if (e.data.keepAlive) {
    return;
  }
  if (handler) {
    if (e.data.error) {
      handler.postError(e.data.error);
    } else {
      handler.postResult(e.data.result);
    }
    handler = null;
  }
  if (answered) {
    answered();
    answered = null;
  }
});

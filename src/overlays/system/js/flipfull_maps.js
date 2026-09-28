'use strict';

(function() {
  const MAPS = 'http://cached.localhost/maps/manifest.webmanifest';

  if (!(window.FlipfullFeatures && window.FlipfullFeatures.maps)) {
    return;
  }

  const WATCH_NAV = `new Promise(resolve => {
    const root = document.documentElement;
    const was = root.getAttribute('data-flipfull-nav');
    new MutationObserver((records, observer) => {
      const now = root.getAttribute('data-flipfull-nav');
      if (now !== was) {
        observer.disconnect();
        resolve(now);
      }
    }).observe(root, { attributes: true, attributeFilter: ['data-flipfull-nav'] });
  })`;

  let source = null;
  let navigating = false;
  let inFront = false;
  let screenLock = null;

  function log(msg) {
    try {
      window.DumpOn ? window.DumpOn(`[Flipfull maps] ${msg}`) : dump(`[Flipfull maps] ${msg}\n`);
    } catch (e) {}
  }

  function read(path) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', path);
      xhr.responseType = 'text';
      xhr.onload = () => xhr.status === 200 ? resolve(xhr.responseText) : reject(new Error(`${path}: ${xhr.status}`));
      xhr.onerror = () => reject(new Error(`${path}: can't read`));
      xhr.send();
    });
  }

  function pageSource() {
    source = source || Promise.all(['route.js', 'page.js', 'page.css', 'nav.css'].map(f => read(`js/maps/${f}`)))
      .then(([route, page, pageCss, navCss]) =>
        `${route}\n${page}\nFlipfullMapsPage(${JSON.stringify(pageCss)}, ${JSON.stringify(navCss)});`);
    return source;
  }

  function updateLock() {
    const want = navigating && inFront;
    if (want && !screenLock) {
      screenLock = navigator.b2g.requestWakeLock('screen');
    } else if (!want && screenLock) {
      screenLock.unlock();
      screenLock = null;
    }
  }

  function watchNav(frame) {
    frame.executeScript(WATCH_NAV).then(state => {
      navigating = state === 'on';
      updateLock();
      watchNav(frame);
    }, () => {});
  }

  function inject(app) {
    if (!app.url.startsWith('https://www.google.com/maps')) {
      return;
    }
    const frame = app.browser.element;
    pageSource()
      .then(src => frame.executeScript(src))
      .then(fresh => {
        if (fresh) {
          navigating = false;
          updateLock();
          watchNav(frame);
        }
      })
      .catch(e => log(`not injected: ${e}`));
  }

  function forMaps(handler) {
    return evt => evt.detail && evt.detail.manifestUrl === MAPS && handler(evt.detail);
  }

  window.addEventListener('applocationchange', forMaps(inject));
  window.addEventListener('apploaded', forMaps(inject));
  window.addEventListener('appforeground', forMaps(() => {
    inFront = true;
    updateLock();
  }));
  window.addEventListener('appbackground', forMaps(() => {
    inFront = false;
    updateLock();
  }));
  window.addEventListener('appterminated', forMaps(() => {
    navigating = false;
    inFront = false;
    updateLock();
  }));
}());

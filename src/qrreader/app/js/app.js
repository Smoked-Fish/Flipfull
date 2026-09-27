'use strict';

(function () {
  const HISTORY_KEY = 'history';
  const HISTORY_MAX = 30;
  const SCAN_MS = 250;
  const LIVE_SIDE = 480;
  const PHOTO_SIDE = 1200;

  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body,
    video: $('video'), hint: $('hint'),
    result: $('result'), kind: $('kind'), value: $('value'), lines: $('lines'), status: $('status'),
    history: $('history'), historyList: $('history-list'),
    left: $('sk-left'), center: $('sk-center'), right: $('sk-right'),
  };
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let view = 'scan';
  let stream = null;
  let timer = null;
  let current = null;
  let actions = {};
  let historyFocus = 0;

  function softkeys(left, center, right) {
    el.left.textContent = left || '';
    el.center.textContent = center || '';
    el.right.textContent = right || '';
  }

  function status(text, isError) {
    el.status.textContent = text || '';
    el.status.classList.toggle('error', !!isError);
  }

  function activity(name, data) {
    return new WebActivity(name, data).start();
  }

  function settle(req) {
    if (req && typeof req.then === 'function') {
      return req;
    }
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('failed'));
    });
  }

  function run(label, promise) {
    status(label);
    return promise.then(() => status(''), (e) => {
      const name = e && (e.name || e.message || String(e));
      if (/NO_PROVIDER|NotFound/i.test(name)) {
        status('No app on the phone can do that', true);
      } else {
        status('');
      }
    });
  }

  function copy(text, what) {
    const done = () => status(what || 'Copied');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(done, () => copyBySelection(text, done));
    }
    copyBySelection(text, done);
    return Promise.resolve();
  }

  function copyBySelection(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      status('Could not copy', true);
    }
    area.remove();
  }

  function decode(source, width, height, maxSide, both) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(image.data, image.width, image.height,
      { inversionAttempts: both ? 'attemptBoth' : 'dontInvert' });
    return code && code.data ? code.data : null;
  }

  async function startCamera() {
    if (stream || view !== 'scan' || document.hidden) {
      return;
    }
    el.hint.textContent = 'Point the camera at a QR code';
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
      });
    } catch (e) {
      el.hint.textContent = 'Camera unavailable. Gallery reads a code from a photo.';
      return;
    }
    if (view !== 'scan' || document.hidden || stream) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    el.video.srcObject = stream;
    el.video.play().catch(() => {});
    tick();
  }

  function stopCamera() {
    clearTimeout(timer);
    timer = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    el.video.srcObject = null;
  }

  function tick() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!stream || view !== 'scan') {
        return;
      }
      const v = el.video;
      if (v.readyState >= 2 && v.videoWidth) {
        const text = decode(v, v.videoWidth, v.videoHeight, LIVE_SIDE, false);
        if (text !== null) {
          if (navigator.vibrate) {
            navigator.vibrate(80);
          }
          remember(text);
          showResult(text);
          return;
        }
      }
      tick();
    }, SCAN_MS);
  }

  async function fromGallery() {
    stopCamera();
    el.hint.textContent = 'Choose a photo with a QR code';
    let picked;
    try {
      picked = await activity('pick', { type: ['image/*'] });
    } catch (e) {
      el.hint.textContent = '';
      return startCamera();
    }
    const blob = picked && (picked.blob || picked);
    let text = null;
    try {
      const bitmap = await createImageBitmap(blob);
      text = decode(bitmap, bitmap.width, bitmap.height, PHOTO_SIDE, true);
      if (bitmap.close) {
        bitmap.close();
      }
    } catch (e) {
      text = null;
    }
    if (text === null) {
      await startCamera();
      el.hint.textContent = 'No QR code found in that photo';
      return;
    }
    remember(text);
    showResult(text);
  }

  function loadHistory() {
    try {
      const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  function remember(text) {
    const list = loadHistory().filter((item) => item.text !== text);
    list.unshift({ text, time: Date.now() });
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
    } catch (e) {}
  }

  async function joinWifi(d) {
    const wifi = navigator.b2g && navigator.b2g.wifiManager;
    if (!wifi) {
      return wifiFallback(d, 'This app can\'t reach Wi-Fi.');
    }
    if (!wifi.enabled) {
      status('Turn on Wi-Fi, then press Connect again', true);
      return activity('configure', { target: 'device', section: 'wifi' }).catch(() => {});
    }
    const init = { ssid: d.ssid, security: d.security, hidden: d.hidden };
    const network = typeof window.WifiNetwork === 'function' ? new window.WifiNetwork(init) : init;
    if (d.security === 'WEP') {
      network.wep = d.password;
      network.keyIndex = 0;
    } else if (d.security !== 'OPEN') {
      network.psk = d.password;
    }
    status(`Connecting to ${d.ssid}...`);
    const onStatus = (e) => {
      if (!e.network || e.network.ssid !== d.ssid) {
        return;
      }
      if (e.status === 'connected') {
        status(`Connected to ${d.ssid}`);
        wifi.removeEventListener('statuschange', onStatus);
      } else if (/fail|wrong/i.test(e.status)) {
        status(`Couldn't connect to ${d.ssid}`, true);
        wifi.removeEventListener('statuschange', onStatus);
      }
    };
    if (wifi.addEventListener) {
      wifi.addEventListener('statuschange', onStatus);
    }
    try {
      await settle(wifi.associate(network));
    } catch (e) {
      if (wifi.removeEventListener) {
        wifi.removeEventListener('statuschange', onStatus);
      }
      return wifiFallback(d, `Couldn't add ${d.ssid}.`);
    }
    return undefined;
  }

  function wifiFallback(d, why) {
    if (d.password) {
      copy(d.password, 'Password copied');
    }
    status(`${why} ${d.password ? 'Password copied; ' : ''}opening Wi-Fi settings.`, true);
    return activity('configure', { target: 'device', section: 'wifi' }).catch(() => {});
  }

  function openUrl(url) {
    return run('Opening...', activity('view', { type: 'url', url }));
  }

  function actionsFor(r) {
    const d = r.data;
    const copyRaw = ['Copy', () => copy(r.raw)];
    switch (r.kind) {
      case 'url':
        return { center: ['Open', () => openUrl(d.url)], right: copyRaw };
      case 'wifi':
        return {
          center: ['Connect', () => joinWifi(d)],
          right: d.password ? ['Copy', () => copy(d.password, 'Password copied')] : copyRaw,
        };
      case 'tel':
        return {
          center: ['Call', () => run('', activity('dial', { type: 'webtelephony/number', number: d.number }))],
          right: ['Copy', () => copy(d.number)],
        };
      case 'sms':
        return {
          center: ['Message', () => run('', activity('new', { type: 'websms/sms', number: d.number, body: d.body }))],
          right: copyRaw,
        };
      case 'email':
        return { center: ['Email', () => openUrl(d.url)], right: copyRaw };
      case 'contact':
        return {
          center: ['Save', () => run('', activity('new', {
            type: 'webcontacts/contact',
            params: {
              givenName: d.givenName || d.name, familyName: d.familyName, lastName: d.familyName,
              tel: d.tel[0] || '', email: d.email[0] || '', company: d.company,
            },
          }))],
          right: copyRaw,
        };
      case 'geo':
        return { center: ['Map', () => openUrl(d.url)], right: copyRaw };
      default:
        return {
          center: ['Search', () => openUrl(`https://www.google.com/search?q=${encodeURIComponent(d.text)}`)],
          right: copyRaw,
        };
    }
  }

  function showScan() {
    view = 'scan';
    el.body.dataset.view = 'scan';
    softkeys('Gallery', '', 'History');
    actions = { left: fromGallery, right: showHistory };
    startCamera();
  }

  function showResult(text) {
    stopCamera();
    view = 'result';
    el.body.dataset.view = 'result';
    current = QrParse.parse(text);
    current.raw = text;
    el.kind.textContent = current.label;
    el.value.textContent = current.title;
    el.lines.innerHTML = '';
    current.lines.forEach((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      el.lines.appendChild(li);
    });
    status('');
    el.result.scrollTop = 0;
    const a = actionsFor(current);
    softkeys('Scan', a.center[0], a.right[0]);
    actions = { left: showScan, center: a.center[1], right: a.right[1] };
  }

  function renderHistory() {
    const list = loadHistory();
    el.historyList.innerHTML = '';
    el.history.classList.toggle('empty', !list.length);
    historyFocus = Math.min(historyFocus, Math.max(0, list.length - 1));
    list.forEach((item, i) => {
      const parsed = QrParse.parse(item.text);
      const li = document.createElement('li');
      const kind = document.createElement('span');
      const text = document.createElement('span');
      kind.className = 'h-kind';
      kind.textContent = `${parsed.label} - ${new Date(item.time).toLocaleString([], {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
      text.className = 'h-text';
      text.textContent = parsed.title;
      li.appendChild(kind);
      li.appendChild(text);
      li.classList.toggle('focus', i === historyFocus);
      el.historyList.appendChild(li);
    });
    const focused = el.historyList.children[historyFocus];
    if (focused && focused.scrollIntoView) {
      focused.scrollIntoView({ block: 'nearest' });
    }
    softkeys('Back', list.length ? 'Open' : '', list.length ? 'Clear' : '');
    actions = {
      left: showScan,
      center: list.length ? () => showResult(list[historyFocus].text) : null,
      right: list.length ? () => {
        localStorage.removeItem(HISTORY_KEY);
        renderHistory();
      } : null,
    };
  }

  function showHistory() {
    stopCamera();
    view = 'history';
    el.body.dataset.view = 'history';
    historyFocus = 0;
    renderHistory();
  }

  function onKey(e) {
    let handled = true;
    switch (e.key) {
      case 'SoftLeft':
        if (actions.left) actions.left();
        break;
      case 'SoftRight':
        if (actions.right) actions.right();
        break;
      case 'Enter':
        if (actions.center) actions.center();
        break;
      case 'ArrowUp':
      case 'ArrowDown': {
        const step = e.key === 'ArrowUp' ? -1 : 1;
        if (view === 'history') {
          const n = el.historyList.children.length;
          if (n) {
            historyFocus = (historyFocus + step + n) % n;
            renderHistory();
          }
        } else if (view === 'result') {
          el.result.scrollTop += step * 40;
        }
        break;
      }
      case 'Backspace':
      case 'GoBack':
        if (view === 'scan') {
          stopCamera();
          window.close();
        } else {
          showScan();
        }
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
    }
  }

  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopCamera();
    } else if (view === 'scan') {
      startCamera();
    }
  });

  window.QrReader = { showResult, showScan, showHistory, decode };
  showScan();
}());

'use strict';

const MODE = location.hash === '#voice-input' ? 'input' : 'assistant';
const PREF_AUTO_INSERT = 'kaiva.auto-insert';
const PREF_MIC_KEY_SET = 'kaiva.mic-key-set';
const PREF_SEARCH = 'kaiva.search-engine';
const PREF_SEARCH_AT_ONCE = 'kaiva.search-at-once';

const SAYINGS = [
  'Open Camera',
  'Call Mom',
  'Call 555 123 4567',
  "Text Alex saying I'm on my way",
  'Turn on Wi-Fi',
  'Turn off Bluetooth',
  'Flashlight on',
  'Open Bluetooth settings',
  'What time is it?',
  'Search for chicken recipes',
  'What is baseball?',
  'Take a note',
  'Wake me up at 6:30',
  'Set an alarm in 20 minutes',
  'What alarms do I have?',
  'Cancel my 7 AM alarm',
  'Start the timer',
];

const TOGGLE_NAMES = {
  wifi: 'Wi-Fi', bluetooth: 'Bluetooth', flashlight: 'Flashlight', data: 'Mobile data',
  airplane: 'Airplane mode',
};

const el = {
  body: document.body,
  title: document.getElementById('title'),
  status: document.getElementById('status'),
  anim: document.getElementById('anim'),
  card: document.getElementById('card'),
  text: document.getElementById('text'),
  detail: document.getElementById('detail'),
  list: document.getElementById('list'),
  left: document.getElementById('sk-left'),
  center: document.getElementById('sk-center'),
  right: document.getElementById('sk-right'),
};

let state = 'idle';
let recorder = null;
let request = null;
let listenFor = 'command';
let resultText = '';
let done = false;
let launchedOut = false;
let source = {};
let handlers = {};
let inClock = false;
let turn = 0;

function pref(name, value) {
  try {
    if (value === undefined) {
      return localStorage.getItem(name);
    }
    localStorage.setItem(name, value);
  } catch (e) {}
  return null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setView(view) {
  el.body.dataset.view = view;
}

function title(text) {
  el.title.textContent = MODE === 'input' ? 'Speech to Text' : text;
}

function softkeys(left, center, right) {
  el.left.textContent = left || '';
  el.center.classList.toggle('mic', center === 'mic');
  el.body.classList.toggle('mic-key', center === 'mic');
  el.center.textContent = center === 'mic' ? '' : center || '';
  el.right.textContent = right || '';
}

function on(map) {
  handlers = map;
}

function setLevel(rms) {
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  const t = Math.min(1, Math.max(0, (db + 60) / 50));
  el.anim.style.setProperty('--level', (1 + t * 0.25).toFixed(3));
}

function progress(status, stage) {
  title('Voice Assistant');
  setView(state === 'working' ? 'working' : 'listening');
  el.anim.dataset.stage = stage;
  el.status.textContent = status;
}

function showCard({ text, detail = '', quote = true, big = false, error = false }) {
  state = 'idle';
  title('Voice Assistant');
  el.card.className = [quote ? '' : 'plain', big ? 'big' : '', error ? 'error' : '']
    .filter(Boolean).join(' ');
  el.text.textContent = text;
  el.detail.textContent = detail;
  setView('card');
  el.card.scrollTop = 0;
}

function scroller(node) {
  return {
    up: () => node.scrollBy(0, -40),
    down: () => node.scrollBy(0, 40),
  };
}

function cancelWork() {
  turn++;
  if (recorder) {
    const r = recorder;
    recorder = null;
    r.release();
  }
  if (request) {
    const c = request;
    request = null;
    c.abort();
  }
  state = 'idle';
}

async function listen(kind = 'command') {
  cancelWork();
  listenFor = kind;
  resultText = '';
  launchedOut = false;
  setLevel(0);
  state = 'starting';
  progress('Starting…', 'wait');
  softkeys('Cancel', '', '');
  on({ left: cancelListening, back: exit });

  const serviceUp = STT.open();
  const rec = new Mic.Recorder({
    onLevel: setLevel,
    onSpeech: () => {
      if (recorder === rec) {
        el.anim.dataset.stage = 'speech';
      }
    },
    onEnd: (pcm) => onClip(rec, pcm),
  });
  recorder = rec;
  try {
    await rec.start();
  } catch (e) {
    if (recorder === rec) {
      console.error('KaiVA: getUserMedia failed', e);
      cancelWork();
      showError('Microphone unavailable');
    }
    return;
  }
  if (recorder !== rec || rec.ended) {
    return;
  }
  state = 'listening';
  progress(kind === 'note' ? 'Listening… say your note' : 'Listening…', 'wait');
  softkeys('Cancel', 'Done', '');
  on({ center: () => rec.stop(true), left: cancelListening, back: exit });

  if (!(await serviceUp) && recorder === rec && state === 'listening') {
    cancelWork();
    showError('Speech service is not running', 'service');
  }
}

async function onClip(rec, pcm) {
  if (recorder !== rec) {
    return;
  }
  recorder = null;
  setLevel(0);
  if (!pcm) {
    showError("Didn't hear anything");
    return;
  }
  state = 'working';
  progress('Transcribing…', 'busy');
  softkeys('Cancel', '', '');
  on({ left: cancelListening, back: exit });
  if (MODE === 'assistant' && listenFor === 'command' && source.from !== 'Internet') {
    KaiOS.apps().catch(() => {});
  }

  const ctrl = new AbortController();
  request = ctrl;
  let text;
  try {
    text = await STT.transcribe(pcm, ctrl);
  } catch (e) {
    if (request === ctrl) {
      request = null;
      console.error('KaiVA: transcription failed', e);
      if (e instanceof TypeError) {
        showError('Speech service is not running', 'service');
      } else {
        showError(`Couldn't transcribe: ${e.message}`);
      }
    }
    return;
  }
  if (request !== ctrl) {
    return;
  }
  request = null;
  if (!text || /^(?:\s*(?:\[[^\]]*\]|\([^)]*\)))+\s*$/.test(text)) {
    showError("Didn't catch that");
    return;
  }
  state = 'idle';
  if (MODE === 'input') {
    gotDictation(text);
  } else if (listenFor === 'note') {
    showText(text);
  } else {
    handle(text);
  }
}

function cancelListening() {
  if (MODE === 'input') {
    leave();
  } else {
    standby();
  }
}

function exit() {
  if (MODE === 'input') {
    leave();
  } else {
    cancelWork();
    window.close();
  }
}

function showError(message, kind) {
  cancelWork();
  if (MODE === 'input') {
    showCard({ text: message, quote: false, error: true });
    softkeys('Retry', '', 'Cancel');
    on({ left: () => listen(), center: () => listen(), right: leave, back: leave });
    return;
  }
  showCard({
    text: message,
    quote: false,
    error: true,
    detail: kind === 'service' ?
      'Start it with: sh /data/local/userinit/services/stt/service.sh start' :
      'Try “Open Camera” or “What time is it?”',
  });
  softkeys('Help', 'mic', 'Settings');
  on({ left: help, center: () => listen(), right: settings, back: exit });
}

function toWorker(msg) {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (sw) {
    sw.postMessage(msg);
  }
}

function leave(text) {
  cancelWork();
  if (!done) {
    done = true;
    toWorker(text === undefined ? { type: 'cancel' } : { type: 'result', text });
  }
  window.close();
}

function gotDictation(text) {
  resultText = text;
  showCard({ text, quote: false });
  if (pref(PREF_AUTO_INSERT) === '1') {
    softkeys('', 'Insert', '');
    on({ back: leave });
    setTimeout(() => leave(resultText), 500);
    return;
  }
  softkeys('Retry', 'Insert', 'Cancel');
  on(Object.assign({
    left: () => listen(),
    center: () => leave(resultText),
    right: leave,
    back: leave,
  }, scroller(el.card)));
}

function standby() {
  cancelWork();
  launchedOut = false;
  title('Voice Assistant');
  setView('standby');
  softkeys('Help', 'mic', 'Settings');
  on({ left: help, center: () => listen(), right: settings, back: exit });
}

function help() {
  cancelWork();
  title('Help');
  el.list.innerHTML = '';
  const add = (cls, text) => {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    el.list.appendChild(li);
  };
  add('caption', 'You can say…');
  SAYINGS.forEach((s) => add('say', s));
  add('caption', `Anything else is searched with ${KaiOS.engine(pref(PREF_SEARCH)).name}` +
    `${pref(PREF_SEARCH_AT_ONCE) === '1' ? '' : ' when you press OK'}. ` +
    'Your voice is understood on the phone and never sent anywhere.');
  setView('list');
  el.list.scrollTop = 0;
  softkeys('Back', 'mic', '');
  on(Object.assign({ left: standby, back: standby, center: () => listen() }, scroller(el.list)));
}

function answer(text, detail) {
  showCard({ text, detail, quote: false, big: true });
  softkeys('Speak', 'OK', '');
  on({ left: () => listen(), center: exit, back: exit });
}

function showText(text, detail) {
  resultText = text;
  showCard({ text, detail });
  softkeys('Retry', 'Search', 'Copy');
  const again = listenFor === 'note' ? () => listen('note') : () => listen();
  on(Object.assign({
    left: again,
    center: () => search(text),
    right: () => copy(text),
    back: exit,
  }, scroller(el.card)));
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
  el.right.textContent = 'Copied';
}

function go(label, start) {
  state = 'working';
  progress(label, 'busy');
  softkeys('Cancel', '', '');
  on({ left: standby, back: exit });
  launchedOut = true;
  let started;
  try {
    started = Promise.resolve(start());
  } catch (e) {
    started = Promise.reject(e);
  }
  return started.then(finish, (err) => {
    const why = String((err && (err.name || err.message)) || err);
    console.warn(`KaiVA: ${label}: ${why}`);
    if (!launchedOut) {
      return;
    }
    if (/NO_PROVIDER|NoProvider|NotFound/i.test(why)) {
      launchedOut = false;
      showError('No app on this phone can do that');
    } else {
      finish();
    }
  });
}

function finish() {
  if (launchedOut) {
    cancelWork();
    window.close();
  }
}

function openOut(label, open, failed) {
  state = 'working';
  progress(label, 'busy');
  softkeys('Cancel', '', '');
  on({ left: standby, back: exit });
  launchedOut = true;
  const mine = turn;
  Promise.resolve().then(open).catch((e) => {
    if (launchedOut && turn === mine) {
      launchedOut = false;
      showError(e.message);
    }
  });
  setTimeout(() => {
    if (launchedOut && turn === mine && !document.hidden) {
      launchedOut = false;
      showError(failed);
    }
  }, 6000);
}

function launchApp(app) {
  const name = app.displayName || app.name;
  openOut(`Opening ${name}`, () => KaiOS.launch(app), `Couldn't open ${name}`);
}

function search(query) {
  const url = KaiOS.searchUrl(query, pref(PREF_SEARCH));
  openOut(`Searching for “${query}”`, () => KaiOS.openBrowser(url), "Couldn't open the browser");
}

function offerSearch(query) {
  if (pref(PREF_SEARCH_AT_ONCE) === '1') {
    return search(query);
  }
  return showText(query, `Search with ${KaiOS.engine(pref(PREF_SEARCH)).name}?`);
}

function contactName(c) {
  return Commands.contactNames(c)[0] || '';
}

async function withClock(start) {
  inClock = true;
  try {
    return await start();
  } finally {
    setTimeout(() => { inClock = false; }, 500);
  }
}

async function timeFormatter(after) {
  const h12 = await after(Promise.race([KaiOS.hour12(), wait(800)]));
  return (hour, minute) => {
    const opts = { hour: 'numeric', minute: '2-digit' };
    if (typeof h12 === 'boolean') {
      opts.hour12 = h12;
    }
    return new Date(2000, 0, 1, hour, minute).toLocaleTimeString('en-US', opts);
  };
}

function dayText(date) {
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(date) - start(new Date())) / 86400000);
  return days === 0 ? 'today' : days === 1 ? 'tomorrow' :
    date.toLocaleDateString('en-US', { weekday: 'long' });
}

function untilText(date) {
  const minutes = Math.max(1, Math.round((date - Date.now()) / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `in ${h ? `${h} h ` : ''}${h && !m ? '' : `${m} min`}`.trim();
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function repeatText(repeat) {
  const on = DAYS.filter((d) => repeat && repeat[d]);
  if (!on.length) return 'Once';
  if (on.length === 7) return 'Every day';
  if (on.length === 5 && on.every((d, i) => d === DAYS[i])) return 'Weekdays';
  if (on.length === 2 && on[0] === 'saturday' && on[1] === 'sunday') return 'Weekends';
  return on.map((d) => d[0].toUpperCase() + d.slice(1, 3)).join(', ');
}

function alarmOn(a) {
  return !!(a.registeredAlarms && (a.registeredAlarms.normal || a.registeredAlarms.snooze));
}

function showAlarms(list, fmt, note) {
  cancelWork();
  title('Alarms');
  el.list.innerHTML = '';
  const add = (cls, text) => {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    el.list.appendChild(li);
  };
  const soon = (a) => (a.hour * 60 + a.minute - (new Date().getHours() * 60 + new Date().getMinutes()) + 1440) % 1440;
  const sorted = list.slice().sort((a, b) => (alarmOn(b) - alarmOn(a)) || soon(a) - soon(b));
  add('caption', note || (list.length ? `${list.length} alarm${list.length === 1 ? '' : 's'}` : 'No alarms set'));
  sorted.forEach((a) => add('alarm', `${fmt(a.hour, a.minute)} · ${repeatText(a.repeat)}` +
    `${a.label ? ` · ${a.label}` : ''}${alarmOn(a) ? '' : ' (off)'}`));
  setView('list');
  el.list.scrollTop = 0;
  softkeys('Back', 'mic', 'Clock');
  on(Object.assign({
    left: standby,
    back: standby,
    center: () => listen(),
    right: () => go('Opening alarms', () => KaiOS.clockTab('alarm')),
  }, scroller(el.list)));
}

function saidTime(when, fmt) {
  if (when.meridiem || when.hour === 0 || when.hour > 12) {
    return fmt(when.hour, when.minute);
  }
  return `${when.hour}:${String(when.minute).padStart(2, '0')}`;
}

function confirmDeleteAll(count) {
  cancelWork();
  showCard({ text: `Delete all ${count} alarm${count === 1 ? '' : 's'}?`, quote: false, big: true });
  softkeys('Cancel', 'Delete', '');
  on({
    left: standby,
    back: standby,
    center: () => {
      state = 'working';
      progress('Deleting alarms', 'busy');
      softkeys('', '', '');
      on({ back: exit });
      withClock(() => KaiOS.deleteAllAlarms()).then(
        () => answer('Alarms deleted', `${count} alarm${count === 1 ? '' : 's'}`),
        (e) => showError(e.message || String(e)));
    },
  });
}

const STALE = new Error('stale');

async function handle(text) {
  const intent = Commands.parse(text);
  console.log(`KaiVA: "${text}" -> ${intent.type}`);
  state = 'working';
  progress(`“${text}”`, 'busy');
  softkeys('Cancel', '', '');
  on({ left: standby, back: exit });
  const mine = turn;
  const after = (promise) => Promise.resolve(promise).then((value) => {
    if (turn !== mine) {
      throw STALE;
    }
    return value;
  }, (err) => {
    throw turn !== mine ? STALE : err;
  });
  try {
    await run(intent, after);
  } catch (e) {
    if (e === STALE) {
      return;
    }
    console.error(`KaiVA: ${intent.type} failed`, e);
    if (state === 'working' && turn === mine) {
      showError(e.message || String(e));
    }
  }
}

async function run(intent, after) {
  switch (intent.type) {
    case 'help':
      return help();

    case 'time': {
      const h12 = await after(Promise.race([KaiOS.hour12(), wait(800)]));
      const now = new Date();
      const opts = { hour: 'numeric', minute: '2-digit' };
      if (typeof h12 === 'boolean') {
        opts.hour12 = h12;
      }
      return answer(now.toLocaleTimeString('en-US', opts),
        now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }));
    }

    case 'date': {
      const now = new Date();
      return answer(now.toLocaleDateString('en-US', { weekday: 'long' }),
        now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
    }

    case 'battery': {
      const b = await after(KaiOS.battery());
      return answer(`${b.level}%`, b.charging ? 'Charging' : 'Battery');
    }

    case 'note':
      return intent.body ? showText(intent.body) : listen('note');

    case 'call': {
      if (intent.number) {
        return go(`Calling ${intent.number}`, () => KaiOS.dial(intent.number));
      }
      const hit = Commands.matchContact(intent.who, await after(KaiOS.contacts()));
      if (!hit) {
        return showText(intent.text, `No contact called “${intent.who}”`);
      }
      const tel = Commands.pickNumber(hit.item, intent.kind);
      return go(`Calling ${contactName(hit.item)}`, () => KaiOS.dial(tel.value));
    }

    case 'text': {
      let number = intent.number;
      let name = number;
      let body = intent.body;
      if (!number) {
        const people = await after(KaiOS.contacts());
        let contact = null;
        if (body) {
          const hit = Commands.matchContact(intent.who, people);
          contact = hit && hit.item;
        } else {
          const split = Commands.splitRecipient(intent.whoWords, intent.whoRaw, people);
          if (split) {
            contact = split.contact;
            body = split.body;
          }
        }
        if (!contact) {
          return showText(intent.text, `No contact called “${intent.who}”`);
        }
        number = Commands.pickNumber(contact, 'mobile').value;
        name = contactName(contact);
      }
      return go(`Texting ${name}`, () => KaiOS.sms(number, body));
    }

    case 'settings':
      return go(`Opening ${intent.label} settings`, () => KaiOS.configure(intent.section));

    case 'toggle': {
      const name = TOGGLE_NAMES[intent.what];
      try {
        await after(KaiOS.toggle(intent.what, intent.on));
      } catch (e) {
        if (e instanceof KaiOS.NeedsSettings) {
          return go(`Opening ${name} settings`, () => KaiOS.configure(e.section));
        }
        throw e;
      }
      return answer(`${name} ${intent.on ? 'on' : 'off'}`);
    }

    case 'open': {
      const app = Commands.matchApp(intent.app, await after(KaiOS.apps()), KaiOS.SELF);
      if (app) {
        return launchApp(app);
      }
      const page = Commands.settingsPage(intent.app);
      if (page) {
        return go(`Opening ${page.label} settings`, () => KaiOS.configure(page.section));
      }
      return showText(intent.text, `No app called “${intent.app}”`);
    }

    case 'alarm': {
      if (!intent.when) {
        return go('Opening alarms', () => KaiOS.clockTab('alarm'));
      }
      const fmt = await timeFormatter(after);
      const date = Commands.alarmDate(intent.when, new Date());
      await after(withClock(() => KaiOS.addAlarm(date)));
      return answer(fmt(date.getHours(), date.getMinutes()),
        `Alarm set for ${dayText(date)}, ${untilText(date)}`);
    }

    case 'alarms': {
      const fmt = await timeFormatter(after);
      return showAlarms(await after(withClock(() => KaiOS.alarms())), fmt);
    }

    case 'alarm-cancel': {
      const fmt = await timeFormatter(after);
      const list = await after(withClock(() => KaiOS.alarms()));
      if (!list.length) {
        return answer('No alarms', 'There is nothing to cancel');
      }
      if (intent.all) {
        return confirmDeleteAll(list.length);
      }
      let targets = list;
      if (intent.when) {
        targets = list.filter((a) => Commands.alarmMatches(a, intent.when));
        if (!targets.length) {
          return showAlarms(list, fmt, `No alarm at ${saidTime(intent.when, fmt)}. Your alarms:`);
        }
      } else if (list.length > 1) {
        return showAlarms(list, fmt, 'Which one? Say, for example, “Cancel the 7 AM alarm”.');
      }
      for (const a of targets) {
        await after(withClock(() => KaiOS.deleteAlarm(a.id)));
      }
      return answer(targets.length === 1 ? 'Alarm deleted' : `${targets.length} alarms deleted`,
        targets.map((a) => fmt(a.hour, a.minute)).join(', '));
    }

    case 'clock':
      return go(`Opening the ${intent.tab}`, () => KaiOS.clockTab(intent.tab));

    case 'search':
      return offerSearch(intent.query);

    default: {
      const words = Commands.simplify(intent.text);
      if (source.from !== 'Internet' && words && words.split(' ').length <= 2) {
        const apps = await after(KaiOS.apps().catch(() => []));
        const app = apps.find((a) => a.type === 'app' &&
          [a.value, a.displayName].some((n) => Commands.simplify(n) === words));
        if (app) {
          return launchApp(app);
        }
      }
      return offerSearch(intent.text.replace(/[.!]+$/, ''));
    }
  }
}

let menu = null;

function renderMenu() {
  if (!menu || el.body.dataset.view !== 'list' || el.title.textContent !== menu.name) {
    return;
  }
  el.list.innerHTML = '';
  menu.items.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = i === menu.focus ? 'item focused' : 'item';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = item.label;
    const value = document.createElement('div');
    value.className = 'value';
    value.textContent = item.value;
    li.append(label, value);
    el.list.appendChild(li);
  });
  const focused = el.list.children[menu.focus];
  if (focused) {
    focused.scrollIntoView({ block: 'nearest' });
  }
  softkeys('Back', menu.items[menu.focus].run ? 'Select' : '', '');
}

function setItem(id, value) {
  const item = menu && menu.items.find((i) => i.id === id);
  if (item) {
    item.value = value;
    renderMenu();
  }
}

function showMenu(name, items, focusId, back) {
  cancelWork();
  title(name);
  menu = { name, items, focus: Math.max(0, items.findIndex((i) => i.id === focusId)) };
  setView('list');
  el.list.scrollTop = 0;
  renderMenu();
  const move = (by) => () => {
    menu.focus = (menu.focus + items.length + by) % items.length;
    renderMenu();
  };
  on({
    left: back,
    back,
    up: move(-1),
    down: move(1),
    center: () => {
      const item = items[menu.focus];
      if (item.run) {
        item.run(item);
      }
    },
  });
}

async function refreshDefaults() {
  try {
    const d = await KaiOS.voiceDefaults();
    setItem('defaults', d.input && d.assistant ? 'KaiVA' : 'Another app. Select to use KaiVA');
    setItem('mickey', d.micKey ? 'On' : 'Off');
  } catch (e) {
    setItem('defaults', "Couldn't read the setting");
    setItem('mickey', "Couldn't read the setting");
  }
}

async function refreshService() {
  setItem('service', 'Checking…');
  const h = await STT.health();
  if (!h) {
    setItem('service', 'Not running');
    setItem('model', 'The speech service is not running');
    return;
  }
  setItem('service', `Running${h.loaded ? ' · model loaded' : ''}`);
  setItem('model', h.name);
}

function modelSummary(m) {
  return `${m.english ? 'English' : 'Many languages'} · ${m.mb} MB`;
}

async function modelPicker() {
  const list = await STT.models();
  if (!list) {
    setItem('model', 'The speech service is not running');
    return;
  }
  showMenu('Speech model', list.models.map((m) => ({
    id: m.file,
    label: m.name,
    value: m.file === list.current ? `In use · ${modelSummary(m)}` : modelSummary(m),
    run: () => STT.useModel(m.file).then(() => settings('model'),
      (e) => setItem(m.file, `Couldn't switch: ${e.message}`)),
  })), list.current, () => settings('model'));
}

function settings(focusId) {
  showMenu('Settings', [
    {
      id: 'defaults',
      label: 'Voice input & assistant',
      value: 'Checking…',
      run: () => KaiOS.claimDefaults(true).then(refreshDefaults,
        () => setItem('defaults', "Couldn't change the setting")),
    },
    {
      id: 'mickey',
      label: 'Mic key in Internet search',
      value: 'Checking…',
      run: (item) => KaiOS.setMicKey(item.value !== 'On').then(refreshDefaults,
        () => setItem('mickey', "Couldn't change the setting")),
    },
    {
      id: 'search',
      label: 'Search engine',
      value: KaiOS.engine(pref(PREF_SEARCH)).name,
      run: () => {
        const next = pref(PREF_SEARCH) === 'google' ? 'qwant' : 'google';
        pref(PREF_SEARCH, next);
        setItem('search', KaiOS.engine(next).name);
      },
    },
    {
      id: 'searchnow',
      label: 'Search at once',
      value: pref(PREF_SEARCH_AT_ONCE) === '1' ? 'On' : 'Off · OK searches',
      run: () => {
        const now = pref(PREF_SEARCH_AT_ONCE) !== '1';
        pref(PREF_SEARCH_AT_ONCE, now ? '1' : '0');
        setItem('searchnow', now ? 'On' : 'Off · OK searches');
      },
    },
    {
      id: 'autoinsert',
      label: 'Insert dictation at once',
      value: pref(PREF_AUTO_INSERT) === '1' ? 'On' : 'Off',
      run: (item) => {
        pref(PREF_AUTO_INSERT, item.value === 'On' ? '0' : '1');
        setItem('autoinsert', item.value === 'On' ? 'Off' : 'On');
      },
    },
    { id: 'model', label: 'Speech model', value: 'Checking…', run: modelPicker },
    { id: 'service', label: 'Speech service', value: 'Checking…', run: refreshService },
    { id: 'about', label: 'KaiVA', value: 'On-device speech to text', run: null },
  ], focusId, standby);
  refreshDefaults();
  refreshService();
  fetch('/manifest.webmanifest').then((r) => r.json()).then((m) => {
    setItem('about', `Version ${m.b2g_features.version} · on-device speech to text`);
  }).catch(() => {});
}

async function adoptDefaults() {
  try {
    if (await KaiOS.claimDefaults(false)) {
      console.log('KaiVA: now the voice input and assistant');
    }
    if (pref(PREF_MIC_KEY_SET) !== '1') {
      await KaiOS.setMicKey(true);
      pref(PREF_MIC_KEY_SET, '1');
    }
  } catch (e) {
    console.warn(`KaiVA: couldn't check the voice defaults: ${e.message}`);
  }
}

let lastCenter = { key: '', at: 0 };

function onKey(e) {
  const k = e.key;
  let name = null;
  if (k === 'Enter' || k === 'MicrophoneToggle') {
    name = 'center';
    const now = Date.now();
    if (!e.repeat && k !== lastCenter.key && now - lastCenter.at < 300) {
      e.preventDefault();
      return;
    }
    if (!e.repeat) {
      lastCenter = { key: k, at: now };
    }
  } else if (k === 'SoftLeft') {
    name = 'left';
  } else if (k === 'SoftRight') {
    name = 'right';
  } else if (k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') {
    name = 'back';
  } else if (k === 'ArrowUp') {
    name = 'up';
  } else if (k === 'ArrowDown') {
    name = 'down';
  } else if (!k.startsWith('Arrow')) {
    return;
  }
  e.preventDefault();
  if (e.repeat || !name) {
    return;
  }
  const fn = handlers[name];
  if (fn) {
    fn();
  }
}

window.addEventListener('keydown', onKey);

window.addEventListener('pagehide', () => {
  cancelWork();
  STT.close();
  if (MODE === 'input' && !done) {
    done = true;
    toWorker({ type: 'cancel' });
  }
});

if (MODE === 'input') {
  el.body.dataset.mode = 'input';
  setInterval(() => toWorker({ type: 'keepalive' }), 5000);
  toWorker({ type: 'hello' });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state !== 'starting') {
      leave();
    }
  });
} else {
  el.body.dataset.mode = 'assistant';
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const data = e.data || {};
      if (data.type === 'assistant') {
        source = data.data || {};
        if (state === 'idle') {
          listen();
        }
      }
    });
    if (navigator.serviceWorker.startMessages) {
      navigator.serviceWorker.startMessages();
    }
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  toWorker({ type: 'hello' });
  document.addEventListener('visibilitychange', () => {
    if (inClock) {
      return;
    }
    if (!document.hidden) {
      STT.open();
      return;
    }
    STT.close();
    if (launchedOut) {
      cancelWork();
      window.close();
    } else if (state === 'listening' || state === 'working') {
      standby();
    }
  });
  setTimeout(adoptDefaults, 2000);
}

listen();

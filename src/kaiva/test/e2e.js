'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  const { execSync } = require('child_process');
  ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')));
}

const APP = path.join(__dirname, '..', 'app');
const ORIGIN = 'http://kaios-voiceassistant.localhost';
const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'kaiva-shots');
const MOCKS = fs.readFileSync(path.join(__dirname, 'e2e-mocks.js'), 'utf8');

const SHARED = {
  'utils/common/lazy_loader.js': 'window.LazyLoader = { load: () => Promise.resolve() };',
  'session/task_scheduler.js': 'window.taskScheduler = {};',
  'session/lib_session.js': `window.libSession = { initService: (s) => {
      window.__log.push(['initService', s.join(',')]); return new Promise((r) => setTimeout(r, 50)); } };`,
  'session/settings/settings_observer.js': `window.SettingsObserver = {
      getValue: (n) => Promise.resolve(window.__settings[n]),
      setValue: (list) => { list.forEach(({ name, value }) => { window.__settings[name] = value; });
        window.__log.push(['setSettings', JSON.stringify(list)]); return Promise.resolve(); } };`,
  'session/contacts_manager/contacts_manager.js': `window.ContactsManager = {
      SortOption: { GIVEN_NAME: 0, FAMILY_NAME: 1, NAME: 2 }, Order: { ASCENDING: 0, DESCENDING: 1 },
      getAll: (opts, batch, main) => { window.__log.push(['contacts.getAll', JSON.stringify(opts), batch, main]);
        let sent = false;
        return new Promise((r) => setTimeout(r, window.__contactsDelay || 0)).then(() => ({ next: () => sent ? Promise.reject(new Error('end'))
            : (sent = true, Promise.resolve(window.__contacts)),
          release: () => window.__log.push(['cursor.release']) })); } };`,
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

let failures = 0;
function ok(cond, msg) {
  if (!cond) {
    failures++;
    console.log(`  FAIL ${msg}`);
  } else {
    console.log(`  ok   ${msg}`);
  }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'manifest.webmanifest'), 'utf8'));
  ok(manifest.b2g_features.core === true, 'manifest: core app');
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
  });

  const stt = { next: 'Hello world.', down: false, requests: [], origins: new Set(), delay: 0, sessions: 0,
    current: 'parakeet.gguf', picked: [] };
  const MODELS = [
    { file: 'ggml-base-q5_1.bin', name: 'Whisper Base', english: false, mb: 60 },
    { file: 'parakeet.gguf', name: 'Parakeet TDT-CTC 110M', english: true, mb: 90 },
  ];
  const modelsJson = () => JSON.stringify({ current: stt.current, models: MODELS });

  async function newPage(hash, pre) {
    const context = await browser.newContext({
      viewport: { width: 240, height: 320 }, deviceScaleFactor: 2, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => { failures++; console.log(`  PAGE ERROR ${e.message}`); });
    page.on('console', (m) => { if (m.type() === 'error') console.log(`  console.error: ${m.text()}`); });
    await page.addInitScript(MOCKS);
    if (pre) await page.addInitScript(pre);
    await page.route(`${ORIGIN}/**`, (route) => {
      const url = new URL(route.request().url());
      const file = path.join(APP, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(APP) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'nope' });
      route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: MIME[path.extname(file)] || 'application/octet-stream',
        headers: { 'Content-Security-Policy':
          `default-src * data: blob:; script-src ${ORIGIN} http://127.0.0.1 http://shared.localhost; object-src 'none'; style-src ${ORIGIN} 'unsafe-inline' http://shared.localhost` } });
    });
    await page.route('http://shared.localhost/**', (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\/js\//, '');
      if (!SHARED[p]) return route.fulfill({ status: 404 });
      route.fulfill({ status: 200, body: SHARED[p], contentType: 'text/javascript' });
    });
    await page.route('http://127.0.0.1:8321/**', async (route) => {
      const req = route.request();
      const origin = req.headers().origin || '';
      stt.origins.add(origin);
      if (stt.down) return route.abort('connectionrefused');
      const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
      if (origin !== ORIGIN) return route.fulfill({ status: 403, body: '{"error":"origin not allowed"}' });
      const p = new URL(req.url()).pathname;
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (p === '/session') {
        stt.sessions++;
        return route.fulfill({ status: 200, headers: cors, contentType: 'text/event-stream', body: ': open\n\n' });
      }
      const json = (body) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body });
      if (p === '/health') {
        return json(JSON.stringify({ ok: true, loaded: true, model: stt.current,
          name: MODELS.find((m) => m.file === stt.current).name, threads: 4, sessions: 1 }));
      }
      if (p === '/models') return json(modelsJson());
      if (p === '/model') {
        stt.current = req.postData();
        stt.picked.push(stt.current);
        return json(modelsJson());
      }
      if (p === '/transcribe') {
        const body = req.postDataBuffer();
        stt.requests.push(body ? body.length : 0);
        if (stt.delay) await new Promise((r) => setTimeout(r, stt.delay));
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/json',
          body: JSON.stringify({ text: stt.next, audio_ms: 1000, ms: 300 }) }).catch(() => {});
      }
      route.fulfill({ status: 404, headers: cors, body: '{}' });
    });
    await page.goto(`${ORIGIN}/index.html${hash}`);
    return page;
  }

  const key = (page, k) => page.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })), k);
  const okKey = async (page) => {
    await key(page, 'Enter');
    await page.waitForTimeout(20);
    await key(page, 'MicrophoneToggle');
    await page.waitForTimeout(20);
  };
  const view = (page) => page.evaluate(() => document.body.dataset.view);
  const softkeys = (page) => page.evaluate(() => ['sk-left', 'sk-center', 'sk-right']
    .map((id) => { const e = document.getElementById(id); return e.classList.contains('mic') ? '(mic)' : e.textContent; }).join(' | '));
  const log = (page) => page.evaluate(() => window.__log);
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const waitView = (page, v, ms = 8000) => page.waitForFunction((v) => document.body.dataset.view === v, v, { timeout: ms })
    .then(() => true, () => false);
  const waitText = (page, sel, re, ms = 8000) => page.waitForFunction(([sel, re]) =>
    new RegExp(re).test(document.querySelector(sel).textContent), [sel, re.source], { timeout: ms }).then(() => true, () => false);

  console.log('keyboard dictation (#voice-input)');
  {
    stt.next = 'Hello world, this is a test.';
    stt.requests = [];
    const page = await newPage('#voice-input');
    ok(await page.evaluate(() => document.body.dataset.mode) === 'input', 'input mode');
    ok(await waitText(page, '#status', /Listening/), 'listening');
    await page.waitForTimeout(700);
    await shot(page, '01-input-listening');
    ok(await page.evaluate(() => document.getElementById('anim').dataset.stage) === 'speech', 'speech detected (stage)');
    ok(await waitView(page, 'card'), 'stopped by itself after speech and showed the text');
    ok(await page.evaluate(() => document.getElementById('text').textContent) === 'Hello world, this is a test.', 'transcript shown');
    ok(await softkeys(page) === 'Retry | Insert | Cancel', `softkeys ${await softkeys(page)}`);
    const bytes = stt.requests[0] || 0;
    ok(bytes > 45000 && bytes < 80000 && bytes % 2 === 0, `16 kHz PCM clip trimmed to speech (${bytes} bytes)`);
    ok([...stt.origins].every((o) => o === ORIGIN), `requests carry the KaiVA origin (${[...stt.origins]})`);
    ok(stt.sessions > 0, 'opened a session, so the service loads the model while you speak');
    ok(!(await log(page)).some((e) => e[0] === 'initService'), 'no api-daemon session on the dictation path');
    await shot(page, '02-input-result');
    await key(page, 'Enter');
    const toWorker = await page.evaluate(() => window.__toWorker);
    ok(toWorker.some((m) => m.type === 'hello'), 'hello sent to the worker');
    ok(toWorker.some((m) => m.type === 'result' && m.text === 'Hello world, this is a test.'), 'result sent to the keyboard');
    ok((await log(page)).some((e) => e[0] === 'close'), 'closed');
    const l = await log(page);
    ok(l.some((e) => e[0] === 'requestChannel') && l.some((e) => e[0] === 'abandonChannel'), 'audio channel taken and released');
    await page.context().close();
  }

  console.log('keyboard dictation: cancel, repeats of the held OK, errors');
  {
    const page = await newPage('#voice-input');
    ok(await waitText(page, '#status', /Listening/), 'listening');
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true })));
    await page.waitForTimeout(100);
    ok(await page.evaluate(() => /Listening/.test(document.getElementById('status').textContent)), 'a repeat of the held OK does not stop listening');
    await key(page, 'Backspace');
    const toWorker = await page.evaluate(() => window.__toWorker);
    ok(toWorker.some((m) => m.type === 'cancel'), 'Back cancels the activity');
    await page.context().close();
  }
  {
    const page = await newPage('#voice-input');
    await page.evaluate(() => { window.__speech = null; });
    ok(await waitText(page, '#status', /Listening/), 'listening (silence)');
    await page.waitForTimeout(300);
    await key(page, 'Enter');
    ok(await waitView(page, 'card'), 'Done with a quiet speaker still transcribes');
    await page.context().close();
  }
  {
    stt.down = true;
    const page = await newPage('#voice-input');
    ok(await waitText(page, '#text', /Speech service is not running/), 'service down -> error');
    ok(await softkeys(page) === 'Retry |  | Cancel', `error softkeys ${await softkeys(page)}`);
    await shot(page, '03-input-error');
    stt.down = false;
    await page.context().close();
  }
  {
    const page = await newPage('#voice-input', 'window.__micFails = true;');
    ok(await waitText(page, '#text', /Microphone unavailable/), 'mic failure -> error');
    await shot(page, '04-input-mic-error');
    ok((await log(page)).some((e) => e[0] === 'abandonChannel'), 'audio channel released after mic failure');
    await page.context().close();
  }
  {
    stt.next = 'Auto inserted text.';
    const page = await newPage('#voice-input');
    await page.evaluate(() => localStorage.setItem('kaiva.auto-insert', '1'));
    await page.reload();
    ok(await waitView(page, 'card'), 'auto-insert: result');
    await page.waitForTimeout(700);
    ok((await page.evaluate(() => window.__toWorker)).some((m) => m.type === 'result' && m.text === 'Auto inserted text.'),
      'auto-insert: inserted without a key press');
    await page.context().close();
  }

  async function say(text, hash = '#voice-assistant') {
    stt.next = text;
    const page = await newPage(hash);
    await page.waitForFunction(() => document.body.dataset.view !== 'listening' ||
      !/Listening|Starting/.test(document.getElementById('status').textContent), null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);
    return page;
  }

  console.log('assistant: open an app');
  {
    const page = await say('Open the camera app.');
    const l = await log(page);
    ok(l.some((e) => e[0] === 'activity' && e[1] === 'get-app'), 'asked the launcher for the app list');
    ok(l.some((e) => e[0] === 'open' && e[1] === 'http://camera.localhost/manifest.webmanifest' && e[3] === 'kind=app,noopener=yes'),
      'opened Camera like the launcher does');
    await page.waitForTimeout(300);
    ok((await log(page)).some((e) => e[0] === 'close'), 'closed once hidden');
    await page.context().close();
  }

  console.log('assistant: call / text contacts');
  {
    const page = await say('Call Mom.');
    await shot(page, '10-assistant-calling');
    const l = await log(page);
    ok(l.some((e) => e[0] === 'activity' && e[1] === 'dial' && e[2].number === '+15550001' && e[2].type === 'webtelephony/number'),
      'dial activity with Mom\'s number');
    ok(await waitText(page, '#status', /Calling Mom/), 'status: Calling Mom');
    await page.context().close();
  }
  {
    const page = await say('Call Dad at work.');
    ok((await log(page)).some((e) => e[0] === 'activity' && e[1] === 'dial' && e[2].number === '+15550003'), 'Dad at work');
    await page.context().close();
  }
  {
    const page = await say("Text mom I'm running late.");
    const act = (await log(page)).find((e) => e[0] === 'activity' && e[1] === 'new');
    ok(act && act[2].number === '+15550001' && act[2].body === "I'm running late." && act[2].type === 'websms/sms',
      `sms activity ${JSON.stringify(act && act[2])}`);
    await page.context().close();
  }
  {
    const page = await say('Call Zebra.');
    ok(await view(page) === 'card', 'unknown contact -> text card');
    ok(/No contact called/.test(await page.evaluate(() => document.getElementById('detail').textContent)), 'says no contact');
    ok(await softkeys(page) === 'Retry | Search | Copy', `softkeys ${await softkeys(page)}`);
    await page.context().close();
  }

  {
    stt.next = 'Call Mom.';
    const page = await newPage('#voice-assistant', 'window.__contactsDelay = 1500;');
    ok(await waitText(page, '#status', /Call Mom/, 10000), 'looking up the contact');
    await key(page, 'SoftLeft');
    await page.waitForTimeout(2000);
    ok(await view(page) === 'standby', 'cancelled -> standby');
    ok(!(await log(page)).some((e) => e[0] === 'activity' && e[1] === 'dial'), 'no call after Cancel during the lookup');
    await page.context().close();
  }

  console.log('assistant: toggles, answers, settings pages');
  {
    const page = await say('Turn on Wi-Fi.');
    ok(await page.evaluate(() => window.__settings['wifi.enabled']) === true, 'wifi.enabled set');
    ok(await page.evaluate(() => document.getElementById('text').textContent) === 'Wi-Fi on', 'answer: Wi-Fi on');
    await shot(page, '11-assistant-toggle');
    await key(page, 'Enter');
    ok((await log(page)).some((e) => e[0] === 'close'), 'OK closes');
    await page.context().close();
  }
  {
    const page = await say('Turn off Bluetooth.');
    ok((await log(page)).some((e) => e[0] === 'activity' && e[1] === 'configure' && e[2].section === 'bluetooth'),
      'no adapter access -> Bluetooth settings');
    await page.context().close();
  }
  {
    const page = await say('What time is it?');
    const t = await page.evaluate(() => document.getElementById('text').textContent);
    ok(/^\d{1,2}:\d{2}\s?(AM|PM)$/.test(t), `time answer ${t}`);
    await shot(page, '12-assistant-time');
    await page.context().close();
  }
  {
    const page = await say('Open Bluetooth settings.');
    ok((await log(page)).some((e) => e[0] === 'activity' && e[1] === 'configure' && e[2].section === 'bluetooth'), 'configure bluetooth');
    await page.context().close();
  }

  console.log('assistant: alarms (Clock app)');
  const ALARMS = `window.__alarms = [
    { id: 1, hour: 7, minute: 0, label: '', registeredAlarms: { normal: 1 },
      repeat: { monday: true, tuesday: true, wednesday: true, thursday: true, friday: true } },
    { id: 2, hour: 21, minute: 15, label: 'Pills', registeredAlarms: {}, repeat: {} }];`;
  async function sayWith(text, pre) {
    stt.next = text;
    const page = await newPage('#voice-assistant', pre);
    await page.waitForFunction(() => document.body.dataset.view !== 'listening' ||
      !/Listening|Starting/.test(document.getElementById('status').textContent), null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(600);
    return page;
  }
  {
    const page = await say('Wake me up at 6:30 tomorrow.');
    const add = (await log(page)).find((e) => e[0] === 'activity' && e[1] === 'setalarm');
    const at = add && new Date(add[2].alarm.time);
    ok(add && add[2].type === 'add' && at.getHours() === 6 && at.getMinutes() === 30 &&
      JSON.stringify(add[2].alarm.repeat) === '{}', `setalarm add ${add && JSON.stringify(add[2])}`);
    ok(await page.evaluate(() => window.__alarms.length) === 1, 'the Clock has the alarm');
    ok(await page.evaluate(() => document.getElementById('text').textContent) === '6:30 AM', 'answer: 6:30 AM');
    ok(/^Alarm set for tomorrow, in /.test(await page.evaluate(() => document.getElementById('detail').textContent)),
      `detail: ${await page.evaluate(() => document.getElementById('detail').textContent)}`);
    ok(await view(page) === 'card', 'still showing (the inline Clock activity did not close KaiVA)');
    await shot(page, '15-assistant-alarm-set');
    await page.context().close();
  }
  {
    const page = await say('Set an alarm in 20 minutes.');
    const add = (await log(page)).find((e) => e[0] === 'activity' && e[1] === 'setalarm');
    const mins = add && Math.round((add[2].alarm.time - Date.now()) / 60000);
    ok(mins >= 19 && mins <= 20, `in 20 minutes (${mins})`);
    await page.context().close();
  }
  {
    const page = await sayWith('What alarms do I have?', ALARMS);
    ok(await view(page) === 'list', 'alarm list');
    const items = await page.evaluate(() => Array.from(document.querySelectorAll('#list li')).map((l) => l.textContent));
    ok(JSON.stringify(items) === JSON.stringify(['2 alarms', '7:00 AM · Weekdays', '9:15 PM · Once · Pills (off)']),
      `items ${JSON.stringify(items)}`);
    ok(await softkeys(page) === 'Back | (mic) | Clock', `softkeys ${await softkeys(page)}`);
    await shot(page, '16-assistant-alarms');
    await page.context().close();
  }
  {
    const page = await sayWith('Cancel my 7 AM alarm.', ALARMS);
    ok(await page.evaluate(() => window.__alarms.map((a) => a.id).join()) === '2', 'deleted the 7 AM one only');
    ok(await page.evaluate(() => document.getElementById('text').textContent) === 'Alarm deleted', 'answer');
    await page.context().close();
  }
  {
    const page = await sayWith('Cancel my alarm.', ALARMS);
    ok(await view(page) === 'list' && /Which one/.test(await page.evaluate(() => document.querySelector('#list li').textContent)),
      'two alarms: asks which');
    ok(await page.evaluate(() => window.__alarms.length) === 2, 'nothing deleted');
    await page.context().close();
  }
  {
    const page = await sayWith('Delete all alarms.', ALARMS);
    ok(await page.evaluate(() => document.getElementById('text').textContent) === 'Delete all 2 alarms?', 'asks first');
    ok(await page.evaluate(() => window.__alarms.length) === 2, 'nothing deleted yet');
    await key(page, 'Enter');
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => window.__alarms.length) === 0, 'Delete: all gone');
    ok(await page.evaluate(() => document.getElementById('text').textContent) === 'Alarms deleted', 'answer');
    await page.context().close();
  }
  {
    const page = await say('Start the timer.');
    ok((await log(page)).some((e) => e[0] === 'activity' && e[1] === 'view' && e[2].type === 'timer'), 'Clock opened at the timer');
    await page.context().close();
  }

  console.log('assistant: search, text, notes');
  const QWANT = 'https://www.qwant.com/?q=';
  const opened = async (page) => (await log(page)).filter((e) => e[0] === 'open').map((e) => e[1]);
  {
    const page = await say('Search for pizza near me.');
    ok(await view(page) === 'card' && (await opened(page)).length === 0, 'search: asks first');
    ok(await page.evaluate(() => document.getElementById('text').textContent) === 'pizza near me', 'shows the query');
    ok(await page.evaluate(() => document.getElementById('detail').textContent) === 'Search with Qwant?', 'names the engine');
    ok(await softkeys(page) === 'Retry | Search | Copy', `softkeys ${await softkeys(page)}`);
    await shot(page, '14-assistant-search-confirm');
    await okKey(page);
    await page.waitForTimeout(300);
    const l = await log(page);
    ok(JSON.stringify(await opened(page)) === JSON.stringify([`${QWANT}pizza%20near%20me&client=kaios-only`]) &&
      l.some((e) => e[0] === 'open' && e[2] === '_blank' && e[3] === 'noopener=yes'),
      `OK searched once with Qwant in a browser window: ${await opened(page)}`);
    ok(!l.some((e) => e[0] === 'activity' && e[1] === 'view'), 'no view activity in between');
    ok(l.some((e) => e[0] === 'close'), 'closed once hidden');
    await page.context().close();
  }
  {
    const page = await say('I think the meeting went well.');
    ok(await view(page) === 'card' && (await opened(page)).length === 0, 'plain speech: asks first');
    ok(await page.evaluate(() => document.getElementById('text').textContent) === 'I think the meeting went well',
      'shows what was said');
    await page.context().close();
  }
  {
    stt.next = 'I think the meeting went well.';
    const page = await newPage('#voice-assistant', "localStorage.setItem('kaiva.search-at-once', '1');");
    await page.waitForTimeout(3800);
    ok((await opened(page)).includes(`${QWANT}I%20think%20the%20meeting%20went%20well&client=kaios-only`),
      `Search at once: searched without OK: ${await opened(page)}`);
    await page.context().close();
  }
  {
    stt.next = 'Pizza near me.';
    const page = await newPage('#voice-assistant', "localStorage.setItem('kaiva.search-engine', 'google');" +
      "localStorage.setItem('kaiva.search-at-once', '1');");
    await page.waitForTimeout(3800);
    ok((await opened(page)).includes('https://www.google.com/search?q=Pizza%20near%20me&client=kaios-only'),
      `Google when picked in Settings: ${await opened(page)}`);
    await page.context().close();
  }
  {
    const page = await say('Camera');
    ok((await log(page)).some((e) => e[0] === 'open' && /camera/.test(e[1])), 'bare app name opens it');
    await page.context().close();
  }
  {
    const page = await say('Take a note. Buy milk and eggs.');
    ok(await page.evaluate(() => document.getElementById('text').textContent) === 'Buy milk and eggs.', 'note body shown');
    ok(await softkeys(page) === 'Retry | Search | Copy', `note softkeys ${await softkeys(page)}`);
    await shot(page, '13-assistant-text');
    await key(page, 'SoftRight');
    ok((await log(page)).some((e) => e[0] === 'clipboard' && e[1] === 'Buy milk and eggs.'), 'Copy');
    ok(await page.evaluate(() => document.getElementById('sk-right').textContent) === 'Copied', 'shows Copied');
    await okKey(page);
    const urls = await opened(page);
    ok(urls.length === 1 && urls[0].startsWith(`${QWANT}Buy%20milk`), `Search from the text card, once: ${urls}`);
    await page.context().close();
  }
  {
    stt.next = 'Nice weather today.';
    const page = await newPage('#voice-assistant');
    await page.evaluate(() => { });
    await page.waitForTimeout(100);
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message',
      { data: { type: 'assistant', data: { from: 'Internet' } } })));
    await page.waitForTimeout(3800);
    ok(await page.evaluate(() => document.getElementById('text').textContent) === 'Nice weather today',
      'from Internet search: plain speech is offered as a search');
    ok(!(await log(page)).some((e) => e[0] === 'activity' && e[1] === 'get-app'), 'without asking for the app list');
    await okKey(page);
    ok((await opened(page)).some((u) => /Nice%20weather/.test(u)), 'OK searches it');
    await page.context().close();
  }

  console.log('assistant: defaults, standby, help, settings');
  {
    const page = await say('Take a note. Hello.');
    await page.waitForTimeout(2200);
    const s = await page.evaluate(() => window.__settings);
    ok(s['voice-input.selected'] === `${ORIGIN}/manifest.webmanifest`, 'claimed voice input (was empty)');
    ok(s['voice-assistant.selected'] === `${ORIGIN}/manifest.webmanifest`, 'claimed the assistant (was Dictate)');
    ok(s['voice-assistant.enabled'] === true, 'mic key in Internet search turned on once');
    await key(page, 'SoftLeft');
    await page.waitForTimeout(200);
    await key(page, 'SoftLeft');
    ok(await view(page) === 'standby', 'Cancel -> standby');
    ok(await softkeys(page) === 'Help | (mic) | Settings', `standby softkeys ${await softkeys(page)}`);
    await shot(page, '20-standby');
    await key(page, 'SoftLeft');
    ok(await view(page) === 'list', 'Help');
    await shot(page, '21-help');
    await key(page, 'Backspace');
    await key(page, 'SoftRight');
    await page.waitForTimeout(400);
    const items = await page.evaluate(() => [...document.querySelectorAll('#list .item')].map((li) => li.textContent));
    ok(items.length === 8, `settings items ${JSON.stringify(items)}`);
    ok(/KaiVA/.test(items[0]), 'voice input & assistant = KaiVA');
    ok(/Mic key in Internet searchOn/.test(items[1]), `mic key: ${items[1]}`);
    ok(/Search engineQwant/.test(items[2]), `search engine: ${items[2]}`);
    ok(/Search at onceOff · OK searches/.test(items[3]), `search at once: ${items[3]}`);
    ok(/Insert dictation at onceOff/.test(items[4]), `insert at once: ${items[4]}`);
    ok(/Speech model.*Parakeet/.test(items[5]), `speech model: ${items[5]}`);
    ok(/Running · model loaded/.test(items[6]), `speech service status: ${items[6]}`);
    await shot(page, '22-settings');
    const focused = () => page.evaluate(() => document.querySelector('#list .focused').textContent);
    const stored = (name) => page.evaluate((n) => localStorage.getItem(n), name);
    await key(page, 'ArrowDown');
    await key(page, 'ArrowDown');
    await okKey(page);
    ok(await stored('kaiva.search-engine') === 'google', 'search engine: Google');
    ok(/Search engineGoogle/.test(await focused()), 'shows Google');
    await okKey(page);
    ok(await stored('kaiva.search-engine') === 'qwant', 'search engine: Qwant again');
    await key(page, 'ArrowDown');
    await okKey(page);
    ok(await stored('kaiva.search-at-once') === '1' && /Search at onceOn/.test(await focused()), 'search at once: On');
    await okKey(page);
    ok(await stored('kaiva.search-at-once') === '0', 'search at once: Off again');
    await key(page, 'ArrowDown');
    await okKey(page);
    ok(await stored('kaiva.auto-insert') === '1' && /Insert dictation at onceOn/.test(await focused()),
      'insert dictation at once: On');
    await key(page, 'ArrowUp');
    await key(page, 'ArrowUp');
    await key(page, 'ArrowUp');
    await okKey(page);
    await page.waitForTimeout(200);
    ok(await page.evaluate(() => window.__settings['voice-assistant.enabled']) === false, 'mic key toggled off');

    await key(page, 'ArrowDown');
    await key(page, 'ArrowDown');
    await key(page, 'ArrowDown');
    await key(page, 'ArrowDown');
    await okKey(page);
    await page.waitForTimeout(300);
    const models = await page.evaluate(() => [...document.querySelectorAll('#list .item')].map((li) => li.textContent));
    ok(await page.evaluate(() => document.getElementById('title').textContent) === 'Speech model' &&
      models.length === 2 && /In use/.test(models[1]) && /Many languages · 60 MB/.test(models[0]),
      `model picker ${JSON.stringify(models)}`);
    ok(/Parakeet/.test(await page.evaluate(() => document.querySelector('#list .focused').textContent)),
      'the model in use is focused');
    await shot(page, '24-speech-model');
    await key(page, 'ArrowUp');
    await okKey(page);
    await page.waitForTimeout(300);
    ok(stt.picked.join() === 'ggml-base-q5_1.bin', `picked once: ${stt.picked}`);
    ok(await page.evaluate(() => document.getElementById('title').textContent) === 'Settings', 'back in Settings');
    ok(/Speech model.*Whisper Base/.test(await page.evaluate(() => document.querySelector('#list .focused').textContent)),
      'Settings shows the new model, focused');
    stt.current = 'parakeet.gguf';
    await page.context().close();
  }
  {
    stt.down = true;
    const page = await say('x');
    ok(/Speech service is not running/.test(await page.evaluate(() => document.getElementById('text').textContent)), 'assistant: service down');
    await shot(page, '23-assistant-error');
    stt.down = false;
    await page.context().close();
  }
  {
    stt.next = 'Hello.';
    const page = await newPage('#voice-assistant');
    await page.waitForTimeout(700);
    await page.evaluate(() => window.__setHidden(true));
    ok(await view(page) === 'standby', 'sent to background while listening -> mic released, standby');
    await page.context().close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : `\nall e2e checks passed (screenshots in ${SHOTS})`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

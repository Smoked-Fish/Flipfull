'use strict';

(function (exports) {
  const SELF = location.origin;
  const MANIFEST = `${SELF}/manifest.webmanifest`;
  const REPLACED = ['http://dictate.localhost/manifest.webmanifest'];

  function timeout(promise, ms, what) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} didn't answer`)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function activity(name, data) {
    return new WebActivity(name, data).start();
  }

  const SHARED = [
    'utils/common/lazy_loader.js',
    'session/task_scheduler.js',
    'session/lib_session.js',
    'session/settings/settings_observer.js',
    'session/contacts_manager/contacts_manager.js',
  ].map((path) => `http://shared.localhost/js/${path}`);

  let sharedReady = null;

  function loadShared() {
    if (!sharedReady) {
      sharedReady = SHARED.reduce((prev, src) => prev.then(() => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error('System services unavailable'));
        document.head.appendChild(script);
      })), Promise.resolve());
    }
    return sharedReady;
  }

  let sessionReady = null;

  function session() {
    if (!sessionReady) {
      sessionReady = timeout(loadShared().then(() =>
        window.libSession.initService(['settingsService', 'contactsService'])), 8000, 'System services');
      sessionReady.catch(() => {
        sessionReady = null;
      });
    }
    return sessionReady;
  }

  async function getSetting(name) {
    await session();
    return timeout(window.SettingsObserver.getValue(name), 3000, 'Settings');
  }

  async function setSettings(list) {
    await session();
    return timeout(window.SettingsObserver.setValue(list), 3000, 'Settings');
  }

  async function voiceDefaults() {
    const [input, assistant, micKey] = await Promise.all([
      getSetting('voice-input.selected'),
      getSetting('voice-assistant.selected'),
      getSetting('voice-assistant.enabled'),
    ]);
    return {
      input: input === MANIFEST,
      assistant: assistant === MANIFEST,
      micKey: micKey === true,
      inputApp: input || '',
      assistantApp: assistant || '',
    };
  }

  async function claimDefaults(force) {
    const d = await voiceDefaults();
    const stale = (url) => !url || REPLACED.includes(url);
    const list = [];
    if (!d.input && (force || stale(d.inputApp))) {
      list.push({ name: 'voice-input.selected', value: MANIFEST },
        { name: 'voice-input.enabled', value: true });
    }
    if (!d.assistant && (force || stale(d.assistantApp))) {
      list.push({ name: 'voice-assistant.selected', value: MANIFEST });
    }
    if (list.length) {
      await setSettings(list);
    }
    return list.length > 0;
  }

  function setMicKey(on) {
    return setSettings([{ name: 'voice-assistant.enabled', value: on }]);
  }

  let appsCache = null;
  let appsAt = 0;

  async function apps() {
    if (appsCache && Date.now() - appsAt < 30000) {
      return appsCache;
    }
    const list = await timeout(activity('get-app'), 6000, 'The app list');
    if (!Array.isArray(list) || !list.length) {
      throw new Error("Couldn't read the app list");
    }
    appsCache = list;
    appsAt = Date.now();
    return list;
  }

  function launch(item) {
    const url = String(item.manifestUrl || '');
    if (item.type === 'bookmark') {
      return openUrl(item.url);
    }
    if (item.type === 'virtual') {
      if (/^https?:.*manifest\.webmanifest$/.test(url)) {
        window.open(url, '_blank', 'kind=app,noopener=yes');
        return Promise.resolve();
      }
      if (/^https?:/.test(item.url || '')) {
        return openUrl(item.url);
      }
      return Promise.reject(new Error(`Open ${item.displayName} from the app list`));
    }
    if (item.role === 'invalid') {
      return Promise.reject(new Error(`${item.displayName} needs an update`));
    }
    window.open(url, '_blank', 'kind=app,noopener=yes');
    return Promise.resolve();
  }

  let contactsCache = null;
  let contactsAt = 0;

  async function contacts() {
    if (contactsCache && Date.now() - contactsAt < 120000) {
      return contactsCache;
    }
    await session();
    const cm = window.ContactsManager;
    const cursor = await timeout(cm.getAll({
      sortBy: cm.SortOption.NAME,
      sortOrder: cm.Order.ASCENDING,
      sortLanguage: navigator.language || 'en-US',
    }, 100, true), 5000, 'Contacts');
    let all = [];
    try {
      for (let i = 0; i < 50; i++) {
        const batch = await timeout(cursor.next(), 5000, 'Contacts');
        if (!batch || !batch.length) {
          break;
        }
        all = all.concat(batch);
      }
    } catch (e) {}
    try {
      cursor.release();
    } catch (e) {}
    contactsCache = all;
    contactsAt = Date.now();
    return all;
  }

  function dial(number) {
    const clean = String(number).replace(/[a-z,;].*$/i, '').replace(/[^\d+#*]/g, '');
    return activity('dial', { type: 'webtelephony/number', number: clean });
  }

  function sms(number, body) {
    return activity('new', { type: 'websms/sms', number, body: body || '' });
  }

  function openUrl(url) {
    return activity('view', { type: 'url', url }).catch(() => {
      window.open(url, '_blank');
    });
  }

  function configure(section) {
    return activity('configure', { target: 'device', section });
  }

  async function searchUrl(query) {
    let base = 'https://www.google.com/search?q={searchTerms}';
    try {
      const cache = await getSetting('search.cache');
      const engine = cache && cache.providers && cache.providers[cache.defaultEngine];
      if (engine && /\{searchTerms\}/.test(engine.searchUrl || '')) {
        base = engine.searchUrl;
      }
    } catch (e) {}
    return base.replace('{searchTerms}', encodeURIComponent(query));
  }

  class NeedsSettings extends Error {
    constructor(section, message) {
      super(message);
      this.section = section;
    }
  }

  async function toggle(what, on) {
    switch (what) {
      case 'wifi':
        return setSettings([{ name: 'wifi.enabled', value: on }]).catch(() => {
          throw new NeedsSettings('wifi-available-networks', "Couldn't change Wi-Fi");
        });
      case 'data':
        return setSettings([{ name: 'ril.data.enabled', value: on }]);
      case 'airplane':
        return setSettings([{ name: 'airplaneMode.enabled', value: on }]);
      case 'bluetooth': {
        const bt = navigator.b2g && navigator.b2g.bluetooth;
        const adapter = bt && bt.defaultAdapter;
        if (!adapter || !adapter.state) {
          throw new NeedsSettings('bluetooth', "Couldn't change Bluetooth");
        }
        if ((adapter.state === 'enabled') === on) {
          return undefined;
        }
        if (/ing$/.test(adapter.state)) {
          throw new Error('Bluetooth is busy, try again');
        }
        return timeout(adapter[on ? 'enable' : 'disable'](), 10000, 'Bluetooth');
      }
      case 'flashlight': {
        if (!navigator.b2g || !navigator.b2g.getFlashlightManager) {
          throw new Error("Couldn't reach the flashlight");
        }
        const flash = await timeout(navigator.b2g.getFlashlightManager(), 3000, 'The flashlight');
        flash.flashlightEnabled = on;
        return undefined;
      }
      default:
        throw new Error(`Can't switch ${what}`);
    }
  }

  async function battery() {
    let b = null;
    if (navigator.getBattery) {
      b = await timeout(navigator.getBattery(), 2000, 'The battery');
    } else {
      b = (navigator.b2g && navigator.b2g.battery) || navigator.battery;
    }
    if (!b || typeof b.level !== 'number') {
      throw new Error("The battery level isn't available");
    }
    return { level: Math.round(b.level * 100), charging: !!b.charging };
  }

  function hour12() {
    return getSetting('locale.hour12').catch(() => undefined);
  }

  async function clock(data) {
    const result = await timeout(activity('setalarm', data), 10000, 'The Clock app');
    if (!result || result.actionState !== 'success') {
      const why = result && result.errorMessage;
      throw new Error(why === 'No Alarm' ? 'No alarms are set' : String(why || 'The Clock app said no'));
    }
    return result;
  }

  function addAlarm(date, label) {
    return clock({ type: 'add', alarm: { time: date.getTime(), repeat: {}, label: label || '' } });
  }

  function alarms() {
    return clock({ type: 'getall' }).then((r) => r.alarmsArray || []);
  }

  function deleteAlarm(id) {
    return clock({ type: 'delete', alarm: { id } });
  }

  function deleteAllAlarms() {
    return clock({ type: 'deleteall' });
  }

  function clockTab(tab) {
    return activity('view', { type: tab });
  }

  Object.assign(exports, {
    SELF, MANIFEST, session, getSetting, voiceDefaults, claimDefaults, setMicKey,
    apps, launch, contacts, dial, sms, openUrl, configure, searchUrl, toggle,
    NeedsSettings, battery, hour12, addAlarm, alarms, deleteAlarm, deleteAllAlarms, clockTab,
  });
})(window.KaiOS = {});

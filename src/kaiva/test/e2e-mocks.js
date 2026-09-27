(() => {
  const log = (window.__log = []);
  window.__settings = {
    'voice-input.selected': '',
    'voice-assistant.selected': 'http://dictate.localhost/manifest.webmanifest',
    'voice-assistant.enabled': false,
    'locale.hour12': true,
    'search.cache': {
      version: 4, defaultEngine: 'ddg',
      providers: { ddg: { searchUrl: 'https://duckduckgo.com/?q={searchTerms}&kp=1' } },
    },
  };
  window.__contacts = [
    { name: 'Mom', tel: [{ atype: 'mobile', value: '+15550001' }] },
    { name: 'Dad', tel: [{ atype: 'home', value: '+15550002' }, { atype: 'work', value: '+15550003' }] },
    { name: 'John Smith', givenName: 'John', familyName: 'Smith', tel: [{ value: '+15550004' }] },
  ];
  window.__apps = [
    { name: 'camera', displayName: 'Camera', value: 'camera', type: 'app', role: null,
      manifestUrl: 'http://camera.localhost/manifest.webmanifest' },
    { name: 'sms', displayName: 'Messages', value: 'messages', type: 'app',
      manifestUrl: 'http://sms.localhost/manifest.webmanifest' },
    { name: 'fm', displayName: 'FM Radio', value: 'fm radio', type: 'app',
      manifestUrl: 'http://fm.localhost/manifest.webmanifest' },
    { name: 'kaios-voiceassistant', displayName: 'Voice Assistant', value: 'voice assistant', type: 'app',
      manifestUrl: 'http://kaios-voiceassistant.localhost/manifest.webmanifest' },
  ];

  window.close = () => log.push(['close']);
  window.open = (...args) => {
    log.push(['open', ...args]);
    if (window.__openHides !== false) setTimeout(() => window.__setHidden(true), 100);
    return null;
  };

  let hidden = false;
  Object.defineProperty(Document.prototype, 'hidden', { get: () => hidden, configurable: true });
  Object.defineProperty(Document.prototype, 'visibilityState',
    { get: () => (hidden ? 'hidden' : 'visible'), configurable: true });
  window.__setHidden = (h) => {
    hidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
  };

  window.__activity = {
    'get-app': () => Promise.resolve(window.__apps),
    dial: () => new Promise(() => {}),
    new: () => new Promise(() => {}),
    view: () => new Promise(() => {}),
    configure: () => new Promise(() => {}),
    setalarm: (data) => new Promise((resolve) => {
      window.__setHidden(true);
      setTimeout(() => {
        const alarms = window.__alarms;
        let result = { actionState: 'success', alarmsArray: [], errorMessage: '', addedAlarmId: null };
        if (data.type === 'add') {
          const d = new Date(data.alarm.time);
          const a = { id: ++window.__alarmId, hour: d.getHours(), minute: d.getMinutes(),
            repeat: data.alarm.repeat, label: data.alarm.label, registeredAlarms: { normal: 1 } };
          alarms.push(a);
          result.addedAlarmId = a.id;
        } else if (data.type === 'getall') {
          result.alarmsArray = JSON.parse(JSON.stringify(alarms));
        } else if (data.type === 'delete') {
          const i = alarms.findIndex((a) => String(a.id) === String(data.alarm.id));
          if (i < 0) result = { errorMessage: 'Do not have this alarm' }; else alarms.splice(i, 1);
        } else if (data.type === 'deleteall') {
          if (!alarms.length) result = { errorMessage: 'No Alarm' }; else alarms.length = 0;
        }
        window.__setHidden(false);
        resolve(result);
      }, 100);
    }),
  };
  window.__alarms = window.__alarms || [];
  window.__alarmId = 100;
  window.WebActivity = class {
    constructor(name, data) {
      this.name = name;
      this.data = data;
    }
    start() {
      log.push(['activity', this.name, this.data]);
      const h = window.__activity[this.name];
      return h ? h(this.data) : Promise.reject('NO_PROVIDER');
    }
  };

  window.__toWorker = [];
  const fakeSW = { postMessage: (m) => window.__toWorker.push(m) };
  if (navigator.serviceWorker) {
    Object.defineProperty(navigator.serviceWorker, 'controller', { get: () => fakeSW });
    navigator.serviceWorker.register = () => Promise.reject(new Error('blocked in test'));
  }

  window.__speech = [0.4, 1.2];
  window.__gumCalls = 0;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    window.__gumCalls++;
    log.push(['getUserMedia', JSON.stringify(constraints)]);
    if (window.__micFails) throw new DOMException('denied', 'NotAllowedError');
    const ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    const osc = ac.createOscillator();
    osc.frequency.value = 220;
    const g = ac.createGain();
    g.gain.value = 0;
    osc.connect(g);
    g.connect(dest);
    osc.start();
    const t = ac.currentTime;
    const plan = window.__speech;
    if (plan) {
      g.gain.setValueAtTime(0.3, t + plan[0]);
      g.gain.setValueAtTime(0, t + plan[0] + plan[1]);
    }
    return dest.stream;
  };

  window.AudioChannelClient = class extends EventTarget {
    constructor(type) {
      super();
      log.push(['audiochannel', type]);
    }
    requestChannel() {
      log.push(['requestChannel']);
      setTimeout(() => this.dispatchEvent(new Event('statechange')), 20);
    }
    abandonChannel() {
      log.push(['abandonChannel']);
    }
  };

  navigator.clipboard.writeText = (t) => {
    log.push(['clipboard', t]);
    return Promise.resolve();
  };
})();

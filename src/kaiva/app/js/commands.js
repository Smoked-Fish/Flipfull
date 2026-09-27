'use strict';

(function (exports) {
  function normWord(word) {
    return word
      .toLowerCase()
      .replace(/[‘’`]/g, "'")
      .replace(/[.,!?;:…"“”«»()[\]{}]/g, '')
      .replace(/^wi-?fi$/, 'wifi')
      .replace(/^e-mail$/, 'email')
      .replace(/^'+|'+$/g, '');
  }

  function tokens(raw) {
    return String(raw || '').trim().split(/\s+/)
      .map((w) => ({ raw: w, norm: normWord(w) }))
      .filter((w) => w.norm);
  }

  function simplify(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[_-]/g, '')
      .replace(/[^a-z0-9' ]/g, ' ')
      .replace(/'/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function lev(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function sound(s) {
    const k = s.replace(/[^a-z]/g, '')
      .replace(/ph/g, 'f').replace(/ck|q/g, 'k').replace(/c(?=[aou]|$)/g, 'k').replace(/c/g, 's')
      .replace(/z/g, 's').replace(/y/g, 'i').replace(/(.)\1+/g, '$1');
    return k.charAt(0) + k.slice(1).replace(/[aeiouhw]/g, '');
  }

  function similarity(a, b) {
    return 1 - lev(a, b) / Math.max(a.length, b.length);
  }

  function nameScore(q, c) {
    if (!q || !c) return 0;
    if (q === c) return 100;
    const qn = q.replace(/ /g, '');
    const cn = c.replace(/ /g, '');
    if (qn === cn) return 96;
    const qw = q.split(' ');
    const cw = c.split(' ');
    if (qw.every((w) => cw.includes(w))) return 88 - 2 * (cw.length - qw.length);
    if (qn.length >= 3 && cn.startsWith(qn)) return 78;
    if (cw.every((w) => qw.includes(w))) return 70;
    if (cn.length >= 3 && qn.startsWith(cn)) return 64;
    let best = 0;
    const whole = similarity(qn, cn);
    if (whole >= 0.7) best = Math.round(80 * whole);
    for (const w of cw) {
      if (w.length < 3) continue;
      const s = similarity(qn, w);
      if (s >= 0.75) best = Math.max(best, Math.round(76 * s));
      if (qn.length >= 3 && sound(qn) === sound(w)) best = Math.max(best, 70);
    }
    if (qn.length >= 3 && sound(qn) === sound(cn)) best = Math.max(best, 74);
    return best;
  }

  const MIN_SCORE = 60;

  const LEAD = new RegExp('^(?:' + [
    'hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'so', 'um', 'uh', 'and', 'please',
    'kaiva', 'kai va', 'kai', 'can you', 'could you', 'would you', 'will you',
    'i want to', 'i wanna', "i'd like to", 'i would like to', 'i need to',
    'i need you to', "let's", 'let me', 'go ahead and', 'just',
  ].join('|') + ') ');
  const TRAIL = / (?:please|now|right now|for me|thanks|thank you)$/;

  const HELP = /^(?:help|help me|what can (?:you|i) (?:do|say)|what (?:should|can|do) i say|(?:what are )?(?:the |your )?commands|how does this work)$/;
  const TIME = /^(?:what(?:'s| is) the time|what time is it|what's the time|tell me the time|(?:the |current )?time|time is it)$/;
  const DATE = /^(?:what(?:'s| is) (?:the |today's )?date(?: today)?|what day is (?:it|today)(?: today)?|what's today|what is today|today's date|(?:the )?date(?: today)?|what's the day)$/;
  const BATTERY = /^(?:how much battery(?: do i have| is left| left)?|(?:what(?:'s| is) )?(?:my |the )?battery(?: level| status| percentage| life)?|how(?:'s| is) (?:my |the )?battery)$/;
  const NOTE = /^(?:take a note|take note|make a note|note down|note that|note|dictate|dictation|start dictation|write (?:this |that |it )?down|type)(?: that)?(?: (.+))?$/;
  const CALL = /^(?:call|dial|phone|ring|ring up|call up|make a call to|make a phone call to|place a call to)(?: to)? (.+)$/;
  const GIVE_CALL = /^give (.+) a (?:call|ring)$/;
  const CALL_KIND = /^(.+?) (?:on|at) (?:(?:his|her|their|the) )?(mobile|cell|cellphone|cell phone|home|work|office)(?: (?:number|phone|line))?$/;
  const TEXT_TO = /^(?:send|write|compose) (?:a |an )?(?:new )?(?:text|text message|message|sms|msg)(?: message)? to (.+)$/;
  const TEXT = /^(?:text|message|sms|msg) (.+)$/;
  const SEND_TO = /^send (.+?) to (.+)$/;
  const SEND_A_TEXT = /^(?:send|write) (.+?) an? (?:text|text message|message|sms|msg)(?: (?:saying|that says) (.+))?$/;
  const SAYING = ['saying', 'that says', 'that reads', 'and say', 'and tell him', 'and tell her',
    'and tell them', 'telling him', 'telling her', 'telling them', 'with the message',
    'with message', 'that'];
  const PAGE_A = /^(?:open |go to |show me |show )?(?:the |my )?(.+?) settings?(?: page)?$/;
  const PAGE_B = /^(?:open |go to |show )?settings (?:for |of )?(?:the )?(.+)$/;
  const TOGGLE_ON_X = /^(?:turn|switch|put|set|flip) (on|off) (.+)$/;
  const TOGGLE_X_ON = /^(?:turn|switch|put|set|flip) (.+) (on|off)$/;
  const TOGGLE_VERB = /^(enable|activate|disable|deactivate) (.+)$/;
  const TOGGLE_BARE = /^(.+) (on|off)$/;
  const OPEN = /^(?:open|launch|start|run|go to|show me|show|take me to|bring up|switch to|fire up|load)(?: up)? (?:the |my |a )?(.+?)(?: (?:app|application|program))?$/;
  const SEARCH = /^(?:search(?: the web| the internet| online| google| on google| the net)?(?: for)?|google|look up|look for|find me|find|search up|web search(?: for)?)(?: about)? (.+)$/;
  const QUESTION = /^(?:what|what's|whats|who|who's|where|where's|when|why|how|which|whose|define|meaning of)\b/;

  const ALARM_SET = [
    /^(?:set|make|create|add|put|schedule)(?: up)?(?: me)?(?: an?| the| my| new| another)* alarms?(?: clock)?(?: (?:for|at|to|on))?(?: (.+))?$/,
    /^(?:wake|get) me(?: up)?(?: (?:at|by|for))?(?: (.+))?$/,
    /^alarm (?:for |at )?(.+)$/,
  ];
  const ALARM_LIST = [
    /^(?:what|which)(?: are| is)?(?: all)?(?: my| the)? alarms?(?: (?:do i have|are set|have i set|i have|is set))?$/,
    /^(?:show|list|check|see|read|tell)(?: me)?(?: all)?(?: my| the)? alarms?$/,
    /^when(?:'s| is| will| does)? my(?: next)? alarm(?: (?:go off|ring|going off|set for))?$/,
    /^(?:do i have|have i set|is there|are there|did i set) (?:an? |any )?alarms?(?: set)?$/,
    /^(?:my )?alarms?$/,
  ];
  const ALARM_DELETE = /^(?:cancel|delete|remove|clear|turn off|disable|switch off|unset|get rid of)( all)?(?: of)?(?: my| the| that)?(?: (.+?))? (alarms?)(?: (?:for|at) (.+))?$/;
  const CLOCK_TAB = /^(?:(?:set|start|open|show)(?: me)?(?: an?| the| my)? )?(timer|stopwatch|stop watch)(?: (?:for|of) .+)?$/;

  const NUMBERS = {
    zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
    thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    a: 1, an: 1,
  };

  function numberList(words) {
    const out = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      let n = /^\d+$/.test(w) ? parseInt(w, 10) : NUMBERS[w];
      if (n === undefined) {
        return null;
      }
      const next = NUMBERS[words[i + 1]];
      if (n >= 20 && n % 10 === 0 && next !== undefined && next > 0 && next < 10) {
        n += next;
        i++;
      } else if ((w === 'oh' || w === 'o') && next !== undefined && next < 10) {
        n = next;
        i++;
      }
      out.push(n);
    }
    return out;
  }

  function clockTime(s) {
    let t = ` ${String(s || '').replace(/-/g, ' ')} `.replace(/\s+/g, ' ');
    let day = null;
    let meridiem = null;
    t = t.replace(/ (tomorrow|today|tonight)(?: (morning|afternoon|evening|night))? /, (m, d, part) => {
      day = d === 'tomorrow' ? 'tomorrow' : 'today';
      if (d === 'tonight' || /afternoon|evening|night/.test(part || '')) meridiem = 'pm';
      if (part === 'morning') meridiem = 'am';
      return ' ';
    });
    t = t.replace(/ (?:in the |this |at )?(morning|afternoon|evening|night)(?: time)? /, (m, part) => {
      meridiem = part === 'morning' ? 'am' : 'pm';
      return ' ';
    });
    t = t.replace(/ (a ?m|p ?m)(?= )/, (m, x) => {
      meridiem = x[0] === 'a' ? 'am' : 'pm';
      return ' ';
    });
    t = t.replace(/ (?:o'clock|oclock|o clock|sharp|exactly|on the dot)(?= )/g, ' ').trim()
      .replace(/^(?:at|for|by|around|about) /, '');

    const rel = t.match(/^in (?:(.+?) (hours?|hrs?)(?: and (.+?) (?:minutes?|mins?))?|(.+?) (?:minutes?|mins?))$/);
    if (rel || /^in (?:an?|one) hour and a half$/.test(t) || /^in half an hour$/.test(t)) {
      if (/^in half an hour$/.test(t)) return { inMinutes: 30 };
      if (/and a half$/.test(t)) return { inMinutes: 90 };
      const count = (words) => {
        const n = numberList(words.split(' '));
        return n && n.length === 1 ? n[0] : null;
      };
      const hours = rel[1] ? count(rel[1]) : 0;
      const minutes = rel[3] ? count(rel[3]) : rel[4] ? count(rel[4]) : 0;
      if (hours === null || minutes === null || hours * 60 + minutes <= 0 || hours > 23) return null;
      return { inMinutes: hours * 60 + minutes };
    }

    let hour = null;
    let minute = 0;
    let m;
    if (/^(?:noon|midday|12 noon)$/.test(t)) {
      return { hour: 12, minute: 0, meridiem: null, day };
    }
    if (t === 'midnight') {
      return { hour: 0, minute: 0, meridiem: null, day };
    }
    if ((m = t.match(/^(?:(a )?quarter|half|(.+?)(?: minutes?)?) (past|after|to|till|before) (.+)$/))) {
      const base = numberList(m[4].split(' '));
      const off = m[1] !== undefined || /^(?:a )?quarter/.test(t) ? 15 : /^half/.test(t) ? 30 :
        (numberList(m[2].split(' ')) || [])[0];
      if (!base || base.length !== 1 || off === undefined || off >= 60) return null;
      hour = base[0];
      minute = /past|after/.test(m[3]) ? off : 60 - off;
      if (!/past|after/.test(m[3])) hour = (hour + 23) % 24;
    } else if ((m = t.match(/^(\d{1,2})(\d{2})$/))) {
      hour = parseInt(m[1], 10);
      minute = parseInt(m[2], 10);
    } else {
      const n = numberList(t.split(' '));
      if (!n || !n.length || n.length > 2) return null;
      [hour, minute = 0] = n;
    }
    if (hour > 23 || minute > 59 || (meridiem && (hour > 12 || hour === 0))) return null;
    if (meridiem) {
      hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
    }
    return { hour, minute, meridiem, day };
  }

  function alarmDate(when, now) {
    const base = new Date(now.getTime());
    if (when.inMinutes) {
      return new Date(base.getTime() + when.inMinutes * 60000);
    }
    const hours = when.meridiem || when.hour === 0 || when.hour > 12 ? [when.hour] :
      when.hour === 12 ? [12, 0] : [when.hour, when.hour + 12];
    let best = null;
    for (const h of hours) {
      const d = new Date(base.getTime());
      d.setHours(h, when.minute, 0, 0);
      if (when.day === 'tomorrow') {
        d.setDate(d.getDate() + 1);
        d.setHours(h, when.minute, 0, 0);
      } else if (d <= base) {
        d.setDate(d.getDate() + 1);
        d.setHours(h, when.minute, 0, 0);
      }
      if (!best || d < best) best = d;
    }
    return best;
  }

  function alarmMatches(alarm, when) {
    if (!when || when.inMinutes || alarm.minute !== when.minute) return false;
    if (when.meridiem || when.hour === 0 || when.hour > 12) return alarm.hour === when.hour;
    return alarm.hour % 12 === when.hour % 12;
  }

  const TOGGLES = [
    ['wifi', /^(?:the )?(?:wifi|wi fi|wireless)(?: connection)?$/],
    ['bluetooth', /^(?:the )?blue ?tooth$/],
    ['flashlight', /^(?:the )?(?:flash ?light|torch|flash|light)$/],
    ['data', /^(?:the |my )?(?:(?:mobile|cellular|cell) )?data$/],
    ['airplane', /^(?:the )?(?:air ?plane|aeroplane|flight)(?: mode)?$/],
  ];

  const PAGES = [
    ['bluetooth', 'Bluetooth', /^blue ?tooth$/],
    ['wifi-available-networks', 'Wi-Fi', /^(?:wifi|wi fi|wireless|networks?|wifi networks?)$/],
    ['hotspot', 'Hotspot', /^(?:hot ?spot|tethering|internet sharing)$/],
    ['battery', 'Battery', /^(?:battery|power)$/],
    ['mediaStorage', 'Storage', /^(?:media )?storage$/],
    ['tones_sounds', 'Sounds', /^(?:sounds?|ring ?tones?|tones|sounds and tones)$/],
  ];

  function toggleTarget(s) {
    const hit = TOGGLES.find(([, re]) => re.test(s));
    return hit ? hit[0] : null;
  }

  function settingsPage(s) {
    const name = simplify(s).replace(/^(?:the|my) /, '');
    const hit = PAGES.find(([, , re]) => re.test(name));
    return hit ? { section: hit[0], label: hit[1] } : null;
  }

  const DIGITS = {
    zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
    five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  };

  function phoneNumber(s) {
    let out = '';
    for (const w of s.split(' ')) {
      if (/^\+?[\d-]+$/.test(w)) {
        out += w.replace(/-/g, '');
      } else if (DIGITS[w]) {
        out += DIGITS[w];
      } else if (w === 'plus' && !out) {
        out = '+';
      } else {
        return null;
      }
    }
    return out.replace(/\D/g, '').length >= 3 ? out : null;
  }

  function findSaying(words) {
    for (let i = 1; i < words.length; i++) {
      for (const sep of SAYING) {
        const sw = sep.split(' ');
        if (sw.every((w, k) => words[i + k] === w) && i + sw.length < words.length) {
          return { at: i, body: i + sw.length };
        }
      }
    }
    return null;
  }

  function parse(raw) {
    const text = String(raw || '').trim();
    const words = tokens(text);
    let t = words.map((w) => w.norm).join(' ');

    let lead = 0;
    for (let m = t.match(LEAD); m; m = t.match(LEAD)) {
      lead += m[0].trim().split(' ').length;
      t = t.slice(m[0].length);
    }
    let short = t;
    while (TRAIL.test(short)) short = short.replace(TRAIL, '');

    const tw = t ? t.split(' ') : [];
    const rawOf = (from, to) => words.slice(lead + from, to === undefined ? undefined : lead + to)
      .map((w) => w.raw).join(' ');
    const suffixStart = (group) => tw.length - group.split(' ').length;
    const intent = (type, extra) => Object.assign({ type, text }, extra);
    let m;

    if (!short) return intent('none');
    if (HELP.test(short)) return intent('help');
    if (TIME.test(short)) return intent('time');
    if (DATE.test(short)) return intent('date');
    if (BATTERY.test(short)) return intent('battery');

    for (const re of ALARM_SET) {
      if ((m = short.match(re))) {
        const when = m[1] ? clockTime(m[1]) : null;
        if (!m[1] || when) return intent('alarm', { when, said: m[1] || '' });
      }
    }
    if (ALARM_LIST.some((re) => re.test(short))) return intent('alarms');
    if ((m = short.match(ALARM_DELETE))) {
      const said = m[4] || m[2] || '';
      const when = said && !/^(?:all|every|each|any)$/.test(said) ? clockTime(said) : null;
      if (!said || when || /^(?:all|every|each|any)$/.test(said)) {
        return intent('alarm-cancel', { when, all: !!m[1] || !when && (m[3] === 'alarms' || /^(?:all|every)$/.test(said)) });
      }
    }
    if ((m = short.match(CLOCK_TAB))) {
      return intent('clock', { tab: m[1] === 'timer' ? 'timer' : 'stopwatch' });
    }

    if ((m = t.match(NOTE))) {
      return intent('note', { body: m[1] ? rawOf(suffixStart(m[1])) : '' });
    }

    if ((m = short.match(GIVE_CALL)) || (m = short.match(CALL))) {
      let who = m[1].replace(/ back$/, '');
      let kind = null;
      const k = who.match(CALL_KIND);
      if (k) {
        who = k[1];
        kind = /home/.test(k[2]) ? 'home' : /work|office/.test(k[2]) ? 'work' : 'mobile';
      }
      return intent('call', { who, number: phoneNumber(who), kind });
    }

    if ((m = t.match(SEND_A_TEXT))) {
      const who = m[1];
      return intent('text', {
        who,
        whoWords: who.split(' '),
        whoRaw: who.split(' '),
        number: phoneNumber(who),
        body: m[2] ? rawOf(suffixStart(m[2])) : '',
      });
    }
    if ((m = t.match(TEXT_TO)) || (m = t.match(TEXT))) {
      const start = suffixStart(m[1]);
      const rest = tw.slice(start);
      const say = findSaying(rest);
      let whoEnd = say ? say.at : rest.length;
      while (!say && whoEnd > 1 && /^(?:please|now|thanks)$/.test(rest[whoEnd - 1])) whoEnd--;
      const who = rest.slice(0, whoEnd).join(' ');
      return intent('text', {
        who,
        whoWords: rest.slice(0, whoEnd),
        whoRaw: words.slice(lead + start, lead + start + whoEnd).map((w) => w.raw),
        number: phoneNumber(who),
        body: say ? rawOf(start + say.body) : '',
      });
    }
    if ((m = t.match(SEND_TO))) {
      const bodyWords = m[1].split(' ').length;
      const who = m[2].replace(TRAIL, '');
      return intent('text', {
        who,
        whoWords: who.split(' '),
        whoRaw: who.split(' '),
        number: phoneNumber(who),
        body: rawOf(1, 1 + bodyWords),
      });
    }

    if ((m = short.match(PAGE_A)) || (m = short.match(PAGE_B))) {
      const page = settingsPage(m[1]);
      if (page) return intent('settings', page);
    }

    for (const re of [TOGGLE_ON_X, TOGGLE_X_ON, TOGGLE_VERB, TOGGLE_BARE]) {
      if ((m = short.match(re))) {
        const onWord = re === TOGGLE_ON_X || re === TOGGLE_VERB ? m[1] : m[2];
        const what = toggleTarget(re === TOGGLE_ON_X || re === TOGGLE_VERB ? m[2] : m[1]);
        if (what) {
          return intent('toggle', { what, on: onWord === 'on' || /^(?:enable|activate)$/.test(onWord) });
        }
      }
    }

    if ((m = short.match(OPEN))) return intent('open', { app: m[1] });
    if ((m = short.match(SEARCH))) return intent('search', { query: m[1] });
    if (QUESTION.test(short) || /\?$/.test(text)) return intent('search', { query: short });

    return intent('none');
  }

  const KIN = [
    ['mom', 'mum', 'mommy', 'mummy', 'mother', 'mama', 'ma'],
    ['dad', 'daddy', 'father', 'papa', 'pa', 'pop', 'pops'],
    ['grandma', 'granny', 'nana', 'grandmother'],
    ['grandpa', 'grandad', 'granddad', 'grandfather'],
    ['wife', 'wifey'],
    ['husband', 'hubby'],
    ['brother', 'bro'],
    ['sister', 'sis'],
  ];

  const APP_KIN = [
    ['messages', 'message', 'messaging', 'texts', 'text messages', 'sms', 'text'],
    ['call log', 'calls', 'recent calls', 'call history', 'recents', 'phone', 'dialer'],
    ['contacts', 'contact', 'address book', 'people', 'phone book', 'phonebook'],
    ['internet', 'browser', 'web', 'web browser'],
    ['gallery', 'photos', 'photo', 'pictures', 'pics', 'images'],
    ['camera', 'cam'],
    ['music', 'songs', 'music player', 'my music'],
    ['fm radio', 'radio', 'fm'],
    ['settings', 'setting', 'preferences', 'system settings'],
    ['clock', 'alarm', 'alarms', 'timer', 'stopwatch', 'alarm clock'],
    ['calendar', 'agenda', 'schedule'],
    ['calculator', 'calc'],
    ['notes', 'note', 'notepad', 'memo', 'memos'],
    ['email', 'mail', 'inbox'],
    ['recorder', 'voice recorder', 'audio recorder', 'sound recorder', 'voice memo'],
    ['file manager', 'files', 'filemanager', 'my files'],
    ['video', 'videos', 'video player'],
    ['store', 'kaistore', 'kai store', 'app store', 'kaios store'],
  ];

  function alternates(q, groups) {
    const group = groups.find((g) => g.includes(q));
    return group ? [q, ...group.filter((w) => w !== q)] : [q];
  }

  function best(q, items, namesOf, groups) {
    const qs = alternates(simplify(q), groups);
    let top = null;
    for (const item of items) {
      for (const name of namesOf(item)) {
        const c = simplify(name);
        for (let i = 0; i < qs.length; i++) {
          let score = nameScore(qs[i], c);
          if (i) score = score >= 86 ? score - 4 : 0;
          if (score >= MIN_SCORE && (!top || score > top.score)) {
            top = { item, score };
          }
        }
      }
    }
    return top;
  }

  function matchApp(name, apps, selfOrigin) {
    const usable = (apps || []).filter((a) => a && a.type !== 'folder' &&
      !(selfOrigin && String(a.manifestUrl || '').startsWith(selfOrigin)));
    const top = best(name, usable, (a) => [a.value, a.displayName, a.name].filter(Boolean), APP_KIN);
    return top && top.item;
  }

  function contactNames(c) {
    const list = [].concat(c.name || []);
    const full = [c.givenName, c.familyName].filter(Boolean).join(' ');
    if (full) list.push(full);
    if (c.givenName) list.push(c.givenName);
    return list.concat(c.nickname || []).filter((n) => typeof n === 'string' && n);
  }

  function telsOf(c) {
    return (c.tel || []).filter((t) => t && t.value);
  }

  function matchContact(name, contacts) {
    const withTel = (contacts || []).filter((c) => telsOf(c).length);
    return best(name, withTel, contactNames, KIN);
  }

  function telType(t) {
    return [].concat(t.atype || t.type || []).join(' ').toLowerCase();
  }

  function pickNumber(contact, kind) {
    const tels = telsOf(contact);
    const want = { mobile: /mobile|cell/, home: /home/, work: /work|office/ }[kind];
    return (want && tels.find((t) => want.test(telType(t)))) ||
      tels.find((t) => t.pref) ||
      tels.find((t) => /mobile|cell/.test(telType(t))) ||
      tels[0];
  }

  function splitRecipient(whoWords, whoRaw, contacts) {
    let top = null;
    for (let n = Math.min(4, whoWords.length); n >= 1; n--) {
      const hit = matchContact(whoWords.slice(0, n).join(' '), contacts);
      if (hit && (!top || hit.score > top.score)) {
        top = { contact: hit.item, score: hit.score, body: whoRaw.slice(n).join(' ') };
      }
    }
    return top;
  }

  Object.assign(exports, {
    parse, normWord, simplify, nameScore, phoneNumber, settingsPage, clockTime, alarmDate, alarmMatches,
    matchApp, matchContact, pickNumber, splitRecipient, contactNames, MIN_SCORE,
  });
})(typeof module !== 'undefined' ? module.exports : (window.Commands = {}));

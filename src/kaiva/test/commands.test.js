'use strict';

const assert = require('assert');
const C = require('../app/js/commands.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.message.split('\n').join('\n  ')}`);
  }
}

function parses(text, expected) {
  check(JSON.stringify(text), () => {
    const got = C.parse(text);
    for (const [k, v] of Object.entries(expected)) {
      assert.deepStrictEqual(got[k], v, `${k}: ${JSON.stringify(got)}`);
    }
  });
}

parses('Call Mom.', { type: 'call', who: 'mom', number: null, kind: null });
parses('Hey KaiVA, could you please call mom on her cell?', { type: 'call', who: 'mom', kind: 'mobile' });
parses('Call Dad at work', { type: 'call', who: 'dad', kind: 'work' });
parses('Call mom back.', { type: 'call', who: 'mom' });
parses('Give Alex a call.', { type: 'call', who: 'alex' });
parses('Call 555-123-4567.', { type: 'call', number: '5551234567' });
parses('Call five five five one two one two', { type: 'call', number: '5551212' });
parses('Dial +1 555 123 4567', { type: 'call', number: '+15551234567' });

parses("Text Mom saying I'll be late.", { type: 'text', who: 'mom', body: "I'll be late." });
parses("Text mom I'm running late", { type: 'text', whoWords: ['mom', "i'm", 'running', 'late'], body: '' });
parses('Send a message to John Smith that the meeting moved.',
  { type: 'text', who: 'john smith', body: 'the meeting moved.' });
parses('Send hello there to Sarah.', { type: 'text', who: 'sarah', body: 'hello there' });
parses('Send mom a text saying On my way!', { type: 'text', who: 'mom', body: 'On my way!' });
parses('Text mom please', { type: 'text', whoWords: ['mom'] });
parses('Text 555 1234 saying hi', { type: 'text', number: '5551234', body: 'hi' });

parses('Turn on Wi-Fi.', { type: 'toggle', what: 'wifi', on: true });
parses('Turn the wifi off', { type: 'toggle', what: 'wifi', on: false });
parses('Turn Bluetooth off.', { type: 'toggle', what: 'bluetooth', on: false });
parses('Flashlight on.', { type: 'toggle', what: 'flashlight', on: true });
parses('Turn on the torch', { type: 'toggle', what: 'flashlight', on: true });
parses('Enable airplane mode.', { type: 'toggle', what: 'airplane', on: true });
parses('Turn off mobile data.', { type: 'toggle', what: 'data', on: false });

parses('Open Bluetooth settings.', { type: 'settings', section: 'bluetooth' });
parses('Show me the Wi-Fi settings', { type: 'settings', section: 'wifi-available-networks' });
parses('Settings for hotspot', { type: 'settings', section: 'hotspot' });

parses('Open the camera app.', { type: 'open', app: 'camera' });
parses('Launch FM Radio', { type: 'open', app: 'fm radio' });
parses('Go to settings.', { type: 'open', app: 'settings' });
parses('Open up my messages', { type: 'open', app: 'messages' });

parses('What time is it?', { type: 'time' });
parses("What's the time?", { type: 'time' });
parses("What's the date today?", { type: 'date' });
parses('What day is it?', { type: 'date' });
parses('How much battery do I have?', { type: 'battery' });
parses('Battery level', { type: 'battery' });

parses('Search for pizza near me.', { type: 'search', query: 'pizza near me' });
parses('Google the weather in Paris', { type: 'search', query: 'the weather in paris' });
parses('What is baseball?', { type: 'search', query: 'what is baseball' });
parses('Where is Iceland?', { type: 'search', query: 'where is iceland' });
parses('How to play chess', { type: 'search', query: 'how to play chess' });
parses('Is it going to rain tomorrow?', { type: 'search' });

parses('Help', { type: 'help' });
parses('What can you do?', { type: 'help' });

parses('Take a note. Buy milk and eggs.', { type: 'note', body: 'Buy milk and eggs.' });
parses('Take a note', { type: 'note', body: '' });
parses('Note that the code is 4471', { type: 'note', body: 'the code is 4471' });

parses('Hello, this is a normal dictated sentence.', { type: 'none' });
parses('I think the meeting went well.', { type: 'none' });
parses('', { type: 'none' });
parses('   ', { type: 'none' });

check('none keeps the transcript as said', () => {
  assert.strictEqual(C.parse('  Hello, World.  ').text, 'Hello, World.');
});

const contacts = [
  { name: 'Mom', tel: [{ atype: 'mobile', value: '+15550001' }] },
  { name: 'Dad', tel: [{ atype: 'home', value: '+15550002' }, { atype: 'work', value: '+15550003' }] },
  { name: 'John Smith', givenName: 'John', familyName: 'Smith', tel: [{ value: '+15550004' }] },
  { name: 'Kaitlyn Ross', givenName: 'Kaitlyn', familyName: 'Ross', tel: [{ atype: 'cell', value: '+15550005' }] },
  { name: 'Poppy', tel: [{ value: '+15550006' }] },
  { name: 'No Number' },
  { name: 'Alex Chen', givenName: 'Alex', familyName: 'Chen', nickname: ['Al'],
    tel: [{ atype: 'home', value: '+15550007' }, { atype: 'mobile', value: '+15550008', pref: false }] },
];

function finds(q, name) {
  check(`contact "${q}" -> ${name}`, () => {
    const hit = C.matchContact(q, contacts);
    assert.strictEqual(hit ? hit.item.name : null, name, hit && `score ${hit.score}`);
  });
}

finds('mom', 'Mom');
finds('mum', 'Mom');
finds('mother', 'Mom');
finds('john', 'John Smith');
finds('john smith', 'John Smith');
finds('jon', 'John Smith');
finds('caitlin', 'Kaitlyn Ross');
finds('alex', 'Alex Chen');
finds('dad', 'Dad');
finds('daddy', 'Dad');
finds('zebra', null);
finds('no number', null);

check('dad never finds Poppy through "pop"', () => {
  const hit = C.matchContact('dad', contacts.filter((c) => c.name !== 'Dad'));
  assert.strictEqual(hit, null);
});

check('pickNumber: kind, then preferred, then mobile, then first', () => {
  const dad = contacts[1];
  const alex = contacts[6];
  assert.strictEqual(C.pickNumber(dad, 'work').value, '+15550003');
  assert.strictEqual(C.pickNumber(dad, null).value, '+15550002');
  assert.strictEqual(C.pickNumber(alex, null).value, '+15550008');
  assert.strictEqual(C.pickNumber(alex, 'home').value, '+15550007');
});

check('splitRecipient: "mom i\'m running late"', () => {
  const s = C.splitRecipient(['mom', "i'm", 'running', 'late'], ['mom', "I'm", 'running', 'late.'], contacts);
  assert.strictEqual(s.contact.name, 'Mom');
  assert.strictEqual(s.body, "I'm running late.");
});

check('splitRecipient: "john smith see you at noon"', () => {
  const s = C.splitRecipient(['john', 'smith', 'see', 'you', 'at', 'noon'],
    ['John', 'Smith', 'see', 'you', 'at', 'noon'], contacts);
  assert.strictEqual(s.contact.name, 'John Smith');
  assert.strictEqual(s.body, 'see you at noon');
});

const apps = [
  { displayName: 'Camera', value: 'camera', type: 'app', manifestUrl: 'http://camera.localhost/manifest.webmanifest' },
  { displayName: 'Messages', value: 'messages', type: 'app', manifestUrl: 'http://sms.localhost/manifest.webmanifest' },
  { displayName: 'FM Radio', value: 'fm radio', type: 'app', manifestUrl: 'http://fm.localhost/manifest.webmanifest' },
  { displayName: 'Gallery', value: 'gallery', type: 'app', manifestUrl: 'http://gallery.localhost/manifest.webmanifest' },
  { displayName: 'Settings', value: 'settings', type: 'app', manifestUrl: 'http://settings.localhost/manifest.webmanifest' },
  { displayName: 'Voice Assistant', value: 'voice assistant', type: 'app',
    manifestUrl: 'http://kaios-voiceassistant.localhost/manifest.webmanifest' },
  { displayName: 'E-Mail', value: 'email', type: 'app', manifestUrl: 'http://email.localhost/manifest.webmanifest' },
  { displayName: 'Tools', value: 'tools', type: 'folder', manifestUrl: 'folder:tools' },
];

function opens(q, name) {
  check(`app "${q}" -> ${name}`, () => {
    const app = C.matchApp(q, apps, 'http://kaios-voiceassistant.localhost');
    assert.strictEqual(app ? app.displayName : null, name);
  });
}

opens('camera', 'Camera');
opens('messages', 'Messages');
opens('texts', 'Messages');
opens('radio', 'FM Radio');
opens('fm radio', 'FM Radio');
opens('photos', 'Gallery');
opens('galary', 'Gallery');
opens('settings', 'Settings');
opens('email', 'E-Mail');
opens('mail', 'E-Mail');
opens('voice assistant', null);
opens('tools', null);
opens('spaceship', null);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('all commands tests passed');

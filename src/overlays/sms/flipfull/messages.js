(function () {
  'use strict';

  var KEY = 'flipfull-sms';
  var DARK_FROM = 20;    // "Automatic" is dark from 8 PM todo shared
  var DARK_UNTIL = 7;    // until 7 AM
  var CLUSTER_MS = 3 * 60 * 1000;

  var SETTINGS = [
    ['theme', 'Theme', [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Automatic (dark 8 PM to 7 AM)']]],
    ['accent', 'Accent color', [['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple'], ['orange', 'Orange'], ['pink', 'Pink']]],
    ['size', 'Text size', [['m', 'Medium'], ['s', 'Small'], ['l', 'Large'], ['xl', 'Extra large']]],
    ['density', 'Spacing', [['normal', 'Normal'], ['compact', 'Tight'], ['roomy', 'Roomy']]],
    ['font', 'Font', [['standard', 'Standard'], ['narrow', 'Narrow (fits more)']]],
    ['preview', 'Conversation preview', [['1', '1 line'], ['2', '2 lines'], ['0', 'Name only']]],
    ['style', 'Message style', [['bubbles', 'Bubbles'], ['plain', 'Plain lines']]],
    ['ts', 'Message times', [['group', 'After each group'], ['all', 'Every message'], ['focus', 'Selected message'], ['off', 'Hidden']]],
    ['days', 'Day headings', [['on', 'Show'], ['off', 'Hide']]]
  ];

  var values = {};
  SETTINGS.forEach(function (s) { values[s[0]] = s[2][0][0]; });

  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    SETTINGS.forEach(function (s) {
      var ok = s[2].some(function (o) { return o[0] === saved[s[0]]; });
      if (ok) { values[s[0]] = saved[s[0]]; }
    });
  } catch (e) { }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(values)); } catch (e) { }
  }

  function isNight() {
    var h = new Date().getHours();
    return h >= DARK_FROM || h < DARK_UNTIL;
  }

  var root = document.documentElement;
  var statusbarColor = null;

  function setStatusbar(color) {
    if (color === statusbarColor) { return; }
    statusbarColor = color;
    var old = document.querySelector('meta[name="theme-color"]');
    var meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = color;
    if (old && old.parentNode) {
      old.parentNode.replaceChild(meta, old);
    } else if (document.head) {
      document.head.appendChild(meta);
    }
  }

  function apply() {
    var theme = values.theme === 'auto' ? (isNight() ? 'dark' : 'light') : values.theme;
    root.classList.add('ff');
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-accent', values.accent);
    root.setAttribute('data-size', values.size);
    root.setAttribute('data-density', values.density);
    root.setAttribute('data-font', values.font);
    root.setAttribute('data-preview', values.preview);
    root.setAttribute('data-style', values.style);
    root.setAttribute('data-ts', values.ts);
    root.setAttribute('data-days', values.days);
    setStatusbar(theme === 'dark' ? '#101214' : '#ffffff');
  }

  apply();

  //  pause the auto-theme when hidden
  var themeTimer = null;
  function startThemeTimer() {
    if (themeTimer) { return; }
    themeTimer = setInterval(function () { if (values.theme === 'auto') { apply(); } }, 60000);
  }
  function stopThemeTimer() {
    if (themeTimer) { clearInterval(themeTimer); themeTimer = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopThemeTimer(); }
    else { if (values.theme === 'auto') { apply(); } startThemeTimer(); }
  });
  startThemeTimer();

  // message grouping
  var pending = false;

  function senderOf(li) {
    var s = li.querySelector('.message-sender');
    return s ? s.textContent : '';
  }

  function group() {
    pending = false;
    fill();
    var box = document.getElementById('messages-container');
    if (!box) { return; }
    var list = box.querySelectorAll('li.message');
    var prev = null;
    for (var i = 0; i < list.length; i++) {
      var li = list[i];
      var cont = false;
      if (prev && prev.parentNode === li.parentNode) {
        cont = prev.classList.contains('incoming') === li.classList.contains('incoming') &&
          Math.abs(li.dataset.timestamp - prev.dataset.timestamp) <= CLUSTER_MS &&
          senderOf(prev) === senderOf(li);
      }
      li.classList.toggle('ff-cont', cont);
      if (prev) { prev.classList.toggle('ff-end', !cont); }
      prev = li;
    }
    if (prev) { prev.classList.add('ff-end'); }
  }

  function fill() {
    var box = document.getElementById('messages-container');
    var ui = window.ThreadUI;
    if (!box || !ui || !ui.showChunkOfMessages) { return; }
    var CHUNK = 20;
    var attempts = 0;
    while (box.querySelector('.hidden') &&
      box.scrollHeight - box.clientHeight < box.clientHeight &&
      attempts < 3) {
      var below = box.scrollHeight - box.scrollTop;
      ui.showChunkOfMessages(CHUNK);
      // single measurement
      box.scrollTop = box.scrollHeight - below;
      attempts++;
    }
  }

  function schedule() {
    if (!pending) {
      pending = true;
      requestAnimationFrame(group);
    }
  }

  // scrolling
  function reveal(li) {
    var box = document.getElementById('messages-container');
    if (!box || !box.contains(li)) { return; }
    var b = box.getBoundingClientRect();
    var r = li.getBoundingClientRect();
    // the first message of a day brings its heading with it
    var first = li.parentNode && li.parentNode.firstElementChild === li;
    var head = first && li.parentNode.parentNode.firstElementChild;
    if (head && head.getBoundingClientRect) { r = { top: head.getBoundingClientRect().top, bottom: r.bottom, height: r.bottom - head.getBoundingClientRect().top }; }
    if (r.height > b.height || r.top < b.top) {
      box.scrollTop += r.top - b.top;
    } else if (r.bottom > b.bottom) {
      box.scrollTop += r.bottom - b.bottom;
    }
  }

  window.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowUp') { return; }
    setTimeout(function () {
      var li = document.querySelector('#messages-container li.message.focus');
      var ui = window.ThreadUI;
      for (var i = 0; li && ui && i < 10 && li.classList.contains('hidden'); i++) {
        ui.showChunkOfMessages(5);
      }
      if (li) { reveal(li); }
    }, 80);
  });

  document.addEventListener('focusin', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('message')) {
      // after the stock scrolling has run
      setTimeout(function () { reveal(t); }, 60);
    }
  }, true);


  // settings
  function heading(text) {
    var h = document.createElement('header');
    h.className = 'container-header p-sec ff-heading';
    var span = document.createElement('span');
    span.textContent = text;
    h.appendChild(span);
    return h;
  }

  function syncSelects() {
    var selects = document.querySelectorAll('select[data-ff]');
    for (var i = 0; i < selects.length; i++) {
      selects[i].value = values[selects[i].getAttribute('data-ff')];
    }
  }

  function build(container) {
    if (container.querySelector('.ff-heading')) { return; }
    var ul = document.createElement('ul');
    ul.className = 'ff-settings';
    SETTINGS.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'navigable';
      var a = document.createElement('a');
      a.className = 'menu-item';
      var label = document.createElement('span');
      label.textContent = s[1];
      var select = document.createElement('select');
      select.className = 'settings-select';
      select.name = 'flipfull.' + s[0];
      select.setAttribute('data-ff', s[0]);
      s[2].forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o[0];
        opt.textContent = o[1];
        select.appendChild(opt);
      });
      select.value = values[s[0]];
      a.appendChild(label);
      a.appendChild(select);
      li.appendChild(a);
      ul.appendChild(li);
    });
    container.insertBefore(ul, container.firstChild);
    container.insertBefore(heading('Look'), ul);
  }

  document.addEventListener('change', function (e) {
    var t = e.target;
    var name = t && t.getAttribute && t.getAttribute('data-ff');
    if (!name) { return; }
    values[name] = t.value;
    save();
    apply();
  }, true);

  window.addEventListener('DOMContentLoaded', function () {
    var box = document.getElementById('messages-container');
    if (box) {
      // dont rescan whole list
      new MutationObserver(function (records) { schedule(records); })
        .observe(box, { childList: true, subtree: true });
      schedule();
    }

    var panel = document.getElementById('messaging-settings');
    if (panel) {
      var add = function () {
        var container = document.getElementById('messaging-settings-container');
        if (container) { build(container); syncSelects(); }
      };
      new MutationObserver(add).observe(panel, { childList: true });
      add();
    }
  });

  window.FlipfullMessages = { values: values, apply: apply, group: group, settings: SETTINGS };
}());
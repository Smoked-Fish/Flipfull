(function () {
  'use strict';

  var DARK_FROM = 20;    // "Automatic" is dark from 8 PM
  var DARK_UNTIL = 7;    //  until 7 AM

  var COMMON = [
    ['theme', 'Theme', [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Automatic (dark 8 PM to 7 AM)']]],
    ['accent', 'Accent color', [['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple'], ['orange', 'Orange'], ['pink', 'Pink']]],
    ['size', 'Text size', [['m', 'Medium'], ['s', 'Small'], ['l', 'Large'], ['xl', 'Extra large']]],
    ['density', 'Spacing', [['normal', 'Normal'], ['compact', 'Tight'], ['roomy', 'Roomy']]],
    ['font', 'Font', [['standard', 'Standard'], ['narrow', 'Narrow (fits more)']]]
  ];

  var root = document.documentElement;
  var settings = COMMON;
  var storageKey = null;
  var statusbar = null;
  var statusbarColor = null;
  var values = {};
  var page = null;
  var rows = [];
  var current = 0;
  var changed = {};

  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(values)); } catch (e) {}
  }

  function isNight() {
    var h = new Date().getHours();
    return h >= DARK_FROM || h < DARK_UNTIL;
  }

  function setStatusbar(color) {
    if (color === statusbarColor) { return; }
    statusbarColor = color;
    var old = document.querySelector('meta[name="theme-color"]');
    var meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = color;
    meta.setAttribute('data-statuscolor', color);
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
    settings.forEach(function (s) {
      if (s[0] !== 'theme') { root.setAttribute('data-' + s[0], values[s[0]]); }
    });
    setStatusbar(statusbar[theme]);
  }


  function px(name, stock) {
    if (!root.classList.contains('ff')) { return stock; }
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:0;height:var(' + name + ')';
    document.body.appendChild(probe);
    var height = probe.offsetHeight;
    document.body.removeChild(probe);
    return height;
  }

  function label(setting) {
    var option = setting[2].filter(function (o) { return o[0] === values[setting[0]]; })[0];
    return option[1];
  }

  function focusRow(i) {
    current = (i + rows.length) % rows.length;
    rows.forEach(function (row, j) { row.classList.toggle('ff-focus', j === current); });
    rows[current].scrollIntoView({ block: 'nearest' });
  }

  function change(step) {
    var setting = settings[current];
    var options = setting[2];
    var at = options.map(function (o) { return o[0]; }).indexOf(values[setting[0]]);
    values[setting[0]] = options[(at + step + options.length) % options.length][0];
    changed[setting[0]] = true;
    rows[current].lastChild.textContent = label(setting);
    save();
    apply();
  }

  function element(tag, className, text) {
    var el = document.createElement(tag);
    el.className = className;
    if (text) { el.textContent = text; }
    return el;
  }

  function close() {
    if (!page) { return; }
    document.body.removeChild(page);
    page = null;
    if (look.onClose) { look.onClose(Object.keys(changed)); }
    changed = {};
  }

  function open() {
    if (page || !storageKey) { return; }
    page = element('div', 'ff-look');
    page.appendChild(element('div', 'ff-look-title', 'Appearance'));
    var list = element('div', 'ff-look-list');
    rows = settings.map(function (s) {
      var row = element('div', 'ff-look-row');
      row.appendChild(element('span', 'ff-look-name', s[1]));
      row.appendChild(element('span', 'ff-look-value', label(s)));
      list.appendChild(row);
      return row;
    });
    page.appendChild(list);
    var keys = element('div', 'ff-look-keys');
    keys.appendChild(element('span', 'ff-look-key', ''));
    keys.appendChild(element('span', 'ff-look-key ff-look-center', 'Change'));
    keys.appendChild(element('span', 'ff-look-key', 'Done'));
    page.appendChild(keys);
    document.body.appendChild(page);
    focusRow(0);
  }

  window.addEventListener('keydown', function (e) {
    if (!page || e.key === 'EndCall') { return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    switch (e.key) {
      case 'ArrowUp': focusRow(current - 1); break;
      case 'ArrowDown': focusRow(current + 1); break;
      case 'ArrowLeft': change(-1); break;
      case 'ArrowRight':
      case 'Enter': change(1); break;
      case 'Backspace':
      case 'BrowserBack':
      case 'SoftLeft':
      case 'SoftRight': close(); break;
    }
  }, true);

  window.addEventListener('keyup', function (e) {
    if (page && e.key !== 'EndCall') {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // config: { feature, key, settings: [the app's own], statusbar: { light, dark } }
  function init(config) {
    var features = window.FlipfullFeatures;
    if (!features || !features[config.feature]) { return null; }
    storageKey = config.key;
    statusbar = config.statusbar;
    settings = COMMON.concat(config.settings || []);
    settings.forEach(function (s) { values[s[0]] = s[2][0][0]; });
    try {
      var saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      settings.forEach(function (s) {
        var ok = s[2].some(function (o) { return o[0] === saved[s[0]]; });
        if (ok) { values[s[0]] = saved[s[0]]; }
      });
    } catch (e) {}
    apply();
    setInterval(function () { if (values.theme === 'auto') { apply(); } }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && values.theme === 'auto') { apply(); }
    });
    return look;
  }

  var look = { init: init, open: open, px: px, onClose: null };
  window.FlipfullLook = look;
}());

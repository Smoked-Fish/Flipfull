'use strict';
define(function(require) {
  const SettingsPanel = require('modules/settings_panel');
  const launchableApps = require('modules/flipfull_apps');

  return function createHomeShortcutsPanel() {
    const SETTING = {
      press: 'home.customization.keypress',
      hold: 'home.customization.longpress'
    };

    let rows = [];
    let saved = { press: [], hold: [] };

    function toList(value) {
      return Array.isArray(value) ? value : [];
    }

    function builtIn(row) {
      if (row.list === 'press') {
        return [['Default', '']];
      }
      return row.key === '1' ? [['None', 'none'], ['Voicemail', '']] :
        [['Speed dial', ''], ['Voicemail', 'voicemail']];
    }

    function valueOf(row, entry) {
      if (!entry) {
        return '';
      }
      if (entry.type === 'voicemail') {
        return row.key === '1' ? '' : 'voicemail';
      }
      return entry.type === 'none' ? 'none' : entry.url || '';
    }

    function entryOf(row) {
      const value = row.select.value;
      return value === 'voicemail' || value === 'none' ? { key: row.key, type: value } :
        { key: row.key, type: 'manifestUrl', url: value };
    }

    function fill(row, apps) {
      const { select } = row;
      const choices = builtIn(row);
      const value = valueOf(row, saved[row.list].find(entry => entry.key === row.key));
      select.innerHTML = '';
      choices.forEach(([label, v]) => select.add(new Option(label, v)));
      apps.forEach(app => select.add(new Option(app.name, app.url)));
      if (!choices.some(([, v]) => v === value) && !apps.some(app => app.url === value)) {
        select.add(new Option('(app not installed)', value));
      }
      select.value = value;
    }

    function save(list) {
      const mine = rows.filter(row => row.list === list).map(row => row.key);
      const kept = saved[list].filter(entry => !mine.includes(entry.key));
      const chosen = rows
        .filter(row => row.list === list && row.select.value)
        .map(entryOf);
      saved[list] = kept.concat(chosen);
      SettingsDBCache.saveSettings({ [SETTING[list]]: saved[list] });
    }

    function reset() {
      rows.forEach(row => {
        row.select.value = '';
      });
      save('press');
      save('hold');
      ToastHelper.showToast('changessaved');
    }

    const softkeys = {
      menuClassName: 'menu-button',
      header: { l10nId: 'message' },
      items: [
        { name: 'Select', l10nId: 'select', priority: 2, method() {} },
        { name: 'Reset', l10nId: 'reset', priority: 3, method: reset }
      ]
    };

    function refresh() {
      return Promise.all([
        SettingsDBCache.getSetting(SETTING.press),
        SettingsDBCache.getSetting(SETTING.hold),
        launchableApps()
      ]).then(([press, hold, apps]) => {
        saved = { press: toList(press), hold: toList(hold) };
        rows.forEach(row => fill(row, apps));
      });
    }

    return SettingsPanel({
      onInit: function onInit(panel) {
        rows = Array.from(panel.querySelectorAll('li[data-list]')).map(li => {
          const row = {
            list: li.dataset.list,
            key: li.dataset.key,
            select: li.querySelector('select')
          };
          row.select.addEventListener('change', () => {
            save(row.list);
            ToastHelper.showToast('changessaved');
          });
          return row;
        });
      },

      onBeforeShow: function onBeforeShow() {
        SettingsSoftkey.init(softkeys);
        SettingsSoftkey.show();
        refresh();
      },

      onBeforeHide: function onBeforeHide() {
        SettingsSoftkey.init(SoftParams.defaultSelect);
      }
    });
  };
});

'use strict';
define(function(require) {
  const SettingsPanel = require('modules/settings_panel');
  require('modules/apps_cache');

  return function createHomeShortcutsPanel() {
    const SETTING = {
      press: 'home.customization.keypress',
      hold: 'home.customization.longpress'
    };
    const DEFAULT_LABEL = { press: 'Default', hold: 'Speed dial' };
    const HIDDEN_ROLES = ['system', 'invisible', 'homescreen', 'input',
      'theme', 'addon', 'langpack'];

    let rows = [];
    let saved = { press: [], hold: [] };

    function toList(value) {
      return Array.isArray(value) ? value : [];
    }

    function launchableApps() {
      return AppsCache.apps().then(apps => {
        const list = [];
        apps.forEach(app => {
          const manifest = app.manifest || app.updateManifest;
          const url = app.manifestUrl || app.manifestURL;
          if (!manifest || !url || HIDDEN_ROLES.includes(manifest.role) ||
              app.status === Constants.AppsStatus.DISABLED) {
            return;
          }
          const helper = new ManifestHelper(manifest);
          list.push({ url, name: helper.short_name || helper.name || url });
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        return list;
      });
    }

    function fill(row, apps) {
      const { select } = row;
      const current = saved[row.list].find(entry => entry.key === row.key);
      select.innerHTML = '';
      select.add(new Option(DEFAULT_LABEL[row.list], ''));
      apps.forEach(app => select.add(new Option(app.name, app.url)));
      if (current && current.url && !apps.some(app => app.url === current.url)) {
        select.add(new Option('(app not installed)', current.url));
      }
      select.value = current && current.url ? current.url : '';
    }

    function save(list) {
      const mine = rows.filter(row => row.list === list).map(row => row.key);
      const kept = saved[list].filter(entry => !mine.includes(entry.key));
      const chosen = rows
        .filter(row => row.list === list && row.select.value)
        .map(row => ({ key: row.key, type: 'manifestUrl', url: row.select.value }));
      saved[list] = kept.concat(chosen);
      SettingsDBCache.saveSettings({ [SETTING[list]]: saved[list] });
      ToastHelper.showToast('changessaved');
    }

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
          row.select.addEventListener('change', () => save(row.list));
          return row;
        });
      },

      onBeforeShow: function onBeforeShow() {
        refresh();
      }
    });
  };
});

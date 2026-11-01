'use strict';
define(function(require) {
  const SettingsPanel = require('modules/settings_panel');
  const launchableApps = require('modules/flipfull_apps');

  return function createSideMenuPanel() {
    const ENABLED = 'flipfull.sidemenu.enabled';
    const HIDDEN = 'flipfull.sidemenu.hidden';
    const APPS = 'flipfull.sidemenu.apps';
    const DEFAULT_PLACES = 4;

    let enabled = null;
    let hidden = null;
    let picks = [];
    let shown = [];

    function showApps(on) {
      shown.forEach(el => el.classList.toggle('hidden', !on));
      window.dispatchEvent(new CustomEvent('refresh'));
    }

    function place(saved, i) {
      return typeof saved[i] === 'string' ? saved[i] : i < DEFAULT_PLACES ? 'default' : '';
    }

    function fill(apps, saved) {
      picks.forEach((select, i) => {
        const value = place(saved, i);
        select.innerHTML = '';
        if (i < DEFAULT_PLACES) {
          select.add(new Option('Default', 'default'));
        }
        select.add(new Option('None', ''));
        apps.forEach(app => select.add(new Option(app.name, app.url)));
        if (value && value !== 'default' && !apps.some(app => app.url === value)) {
          select.add(new Option('(app not installed)', value));
        }
        select.value = value;
      });
    }

    function save() {
      SettingsDBCache.saveSettings({ [APPS]: picks.map(select => select.value) });
      ToastHelper.showToast('changessaved');
    }

    function reset() {
      enabled.value = 'true';
      hidden.value = 'false';
      picks.forEach((select, i) => {
        select.value = place([], i);
      });
      SettingsDBCache.saveSettings({
        [ENABLED]: true,
        [HIDDEN]: false,
        [APPS]: picks.map(select => select.value)
      });
      showApps(true);
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

    return SettingsPanel({
      onInit: function onInit(panel) {
        enabled = panel.querySelector(`select[data-name="${ENABLED}"]`);
        hidden = panel.querySelector(`select[data-name="${HIDDEN}"]`);
        picks = Array.from(panel.querySelectorAll('li[data-place] select'));
        shown = Array.from(panel.querySelectorAll('.side-menu-on'));
        enabled.addEventListener('change', () => {
          showApps(enabled.value === 'true');
          ToastHelper.showToast('changessaved');
        });
        hidden.addEventListener('change', () => ToastHelper.showToast('changessaved'));
        picks.forEach(select => select.addEventListener('change', save));
      },

      onBeforeShow: function onBeforeShow() {
        SettingsSoftkey.init(softkeys);
        SettingsSoftkey.show();
        Promise.all([
          SettingsDBCache.getSetting(ENABLED),
          SettingsDBCache.getSetting(APPS),
          launchableApps()
        ]).then(([on, saved, apps]) => {
          fill(apps, Array.isArray(saved) ? saved : []);
          showApps(on !== false);
        });
      },

      onBeforeHide: function onBeforeHide() {
        SettingsSoftkey.init(SoftParams.defaultSelect);
      }
    });
  };
});

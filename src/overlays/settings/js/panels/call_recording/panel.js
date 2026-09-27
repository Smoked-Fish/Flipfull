'use strict';
define(function(require) {
  const SettingsPanel = require('modules/settings_panel');

  return function createCallRecordingPanel() {
    const MODE_KEY = 'callrecording.mode';
    const FORMAT_KEY = 'callrecording.file.format';
    const WATCHED = [MODE_KEY, 'callrecording.notification.enabled',
      'callrecording.vibration.enabled'];

    function handleSettings() {
      ToastHelper.showToast('changessaved');
    }

    function handleMode(mode) {
      if (mode && mode !== 'off') {
        SettingsDBCache.saveSettings({ [FORMAT_KEY]: 'ogg' });
      }
    }

    return SettingsPanel({
      onBeforeShow: function onBeforeShow() {
        WATCHED.forEach(key => {
          SettingsDBCache.observe(key, null, handleSettings, true);
        });
        SettingsDBCache.observe(MODE_KEY, 'off', handleMode, true);
      },

      onBeforeHide: function onBeforeHide() {
        WATCHED.forEach(key => {
          SettingsDBCache.unobserve(key, handleSettings);
        });
        SettingsDBCache.unobserve(MODE_KEY, handleMode);
      }
    });
  };
});

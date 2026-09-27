'use strict';
define(function(require) {
  const SettingsPanel = require('modules/settings_panel');

  return function createCallRecordingPanel() {
    const WATCHED = ['callrecording.mode', 'callrecording.notification.enabled',
      'callrecording.vibration.enabled'];

    function handleSettings() {
      ToastHelper.showToast('changessaved');
    }

    return SettingsPanel({
      onBeforeShow: function onBeforeShow() {
        WATCHED.forEach(key => {
          SettingsDBCache.observe(key, null, handleSettings, true);
        });
      },

      onBeforeHide: function onBeforeHide() {
        WATCHED.forEach(key => {
          SettingsDBCache.unobserve(key, handleSettings);
        });
      }
    });
  };
});

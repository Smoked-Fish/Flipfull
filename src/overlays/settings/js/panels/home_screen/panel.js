'use strict';
define(function(require) {
  const SettingsPanel = require('modules/settings_panel');

  return function createHomeScreenPanel() {
    return SettingsPanel({
      onInit: function onInit(panel) {
        panel.querySelector('#home-screen-shortcuts').classList.toggle('hidden',
            !(window.FlipfullFeatures && FlipfullFeatures['home-shortcuts']));
        panel.querySelector('#home-screen-side-menu').classList.toggle('hidden',
            !(window.FlipfullFeatures && FlipfullFeatures['side-menu']));
        panel.querySelector('#home-screen-switcher-key').classList.toggle('hidden',
            !(window.FlipfullFeatures && FlipfullFeatures['app-switcher']));
        panel.querySelector('#home-screen-switcher-transition-speed').classList.toggle('hidden',
            !(window.FlipfullFeatures && FlipfullFeatures['app-switcher']));

      }
    });
  };
});

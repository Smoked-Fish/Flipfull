(function() {
  'use strict';

  function getKaiAd(config) {
    setTimeout(function() {
      if (config && typeof config.onerror === 'function') {
        config.onerror(19);
      }
    }, 0);
  }

  window.getKaiAd = getKaiAd;
}());

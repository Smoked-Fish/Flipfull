(function () {
  'use strict';

  if (!window.FlipfullLook) { return; }

  var LAYOUT = ['size', 'density', 'font', 'snippet', 'avatar'];

  var look = FlipfullLook.init({
    feature: 'email-redesign',
    key: 'flipfull-email',
    settings: [
      ['snippet', 'Message preview', [['show', 'Show'], ['hide', 'Hide']]],
      ['avatar', 'Sender pictures', [['show', 'Show'], ['hide', 'Hide']]]
    ],
    statusbar: { light: '#ffffff', dark: '#101214' }
  });
  if (!look) { return; }

  look.onClose = function (changed) {
    if (changed.some(function (id) { return LAYOUT.indexOf(id) >= 0; })) { location.reload(); }
  };
}());

(function () {
  'use strict';

  if (!window.FlipfullLook) { return; }

  var LAYOUT = ['size', 'density', 'font', 'times', 'days'];

  var look = FlipfullLook.init({
    feature: 'call-log-redesign',
    key: 'flipfull-call-log',
    settings: [
      ['picture', 'Contact pictures', [['show', 'Show'], ['hide', 'Hide']]],
      ['times', 'Call times', [['show', 'Show'], ['hide', 'Hide']]],
      ['days', 'Day headings', [['show', 'Show'], ['hide', 'Hide']]]
    ],
    statusbar: { light: '#ffffff', dark: '#101214' }
  });
  if (!look) { return; }

  look.onClose = function (changed) {
    if (changed.some(function (id) { return LAYOUT.indexOf(id) >= 0; })) { location.reload(); }
  };
}());

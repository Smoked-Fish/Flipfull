(function () {
  'use strict';

  if (!window.FlipfullLook) { return; }

  var look = FlipfullLook.init({
    feature: 'contacts-redesign',
    key: 'flipfull-contacts',
    settings: [
      ['picture', 'Contact pictures', [['show', 'Show'], ['hide', 'Hide']]],
      ['labels', 'Labels in a contact', [['show', 'Show'], ['hide', 'Hide']]]
    ],
    statusbar: { light: '#ffffff', dark: '#101214' }
  });
  if (!look) { return; }

  function addEntry() {
    var body = document.querySelector('#setting-view .body');
    if (!body || body.querySelector('.ff-entry')) { return; }
    var row = document.createElement('div');
    row.className = 'list-item navigable button ff-entry';
    row.tabIndex = -1;
    row.innerHTML = '<div class="content"><div class="primary">Appearance</div><div class="secondary"></div></div>';
    body.insertBefore(row, body.firstChild);
  }

  window.addEventListener('keydown', function (e) {
    var focus = document.activeElement;
    if (e.key === 'Enter' && focus && focus.classList.contains('ff-entry')) {
      e.stopImmediatePropagation();
      look.open();
    }
  }, true);

  window.addEventListener('DOMContentLoaded', function () {
    new MutationObserver(addEntry).observe(document.body, { childList: true, subtree: true });
  });
}());

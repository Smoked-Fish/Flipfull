'use strict';

(function(exports) {
  const INFO_EVENT = 'flipfull-outer-info';

  function featureOn(id) {
    return !!(window.FlipfullFeatures && window.FlipfullFeatures[id]);
  }

  function log(msg) {
    try {
      window.DumpOn ? window.DumpOn(`[Flipfull] ${msg}`) : dump(`[Flipfull] ${msg}\n`);
    } catch (e) {}
  }

  function manifestURL(name) {
    return window.AppOrigin ? window.AppOrigin.getManifestURL(name) : `http://${name}.localhost/manifest.webmanifest`;
  }

  const MEDIA = {
    'volume-up-button-press': 'media-next-track-button-press',
    'volume-down-button-press': 'media-previous-track-button-press'
  };

  function playingOrigin() {
    const service = window.core && window.core.audioChannelService;
    const channels = service && service._activeAudioChannels;
    let origin = null;
    if (channels) {
      channels.forEach(channel => {
        if (!origin && channel.isPlaying() && channel.name === 'content' && channel.app) {
          const url = channel.app.origin || channel.app.manifestURL || channel.app.manifestUrl;
          try {
            origin = url ? new URL(url).origin : null;
          } catch (e) {
            origin = null;
          }
        }
      });
    }
    return origin;
  }

  function sendMediaButton(origin, message) {
    if (typeof Components === 'undefined' || !Components.classes) {
      return false;
    }
    try {
      Components.classes['@mozilla.org/systemmessage-service;1']
        .getService(Components.interfaces.nsISystemMessageService)
        .sendMessage('media-button', { message }, origin);
      return true;
    } catch (e) {
      log(`media-button to ${origin} failed: ${e}`);
      return false;
    }
  }

  const FlipfullMedia = {
    hold(direction) {
      if (!featureOn('track-skip') || !window.ScreenManager || window.ScreenManager.lidOpened !== false) {
        return false;
      }
      const message = MEDIA[direction];
      const origin = message && playingOrigin();
      if (!origin || !sendMediaButton(origin, message)) {
        return false;
      }
      log(`${message} -> ${origin}`);
      navigator.vibrate(50);
      return true;
    }
  };

  function startOuterFeed() {
    const calls = manifestURL('communications');
    const messages = manifestURL('sms');
    let last = '';

    function update() {
      let list = [];
      try {
        list = (window.Service && window.Service.query('NotificationStore.getAll')) || [];
      } catch (e) {
        return;
      }
      const detail = {
        calls: list.filter(n => n.manifestURL === calls).length,
        messages: list.filter(n => n.manifestURL === messages).length
      };
      const json = JSON.stringify(detail);
      if (json !== last && window.ExternalScreenManager) {
        last = json;
        window.ExternalScreenManager.send(new CustomEvent(INFO_EVENT, { detail }));
      }
    }

    ['notification-store-ready', 'notification-update-launcher',
     'statusbar-update-launcher', 'flipchange', 'screenchange'
    ].forEach(type => window.addEventListener(type, () => setTimeout(update)));
    update();
  }

  function startMain() {
    exports.FlipfullMedia = FlipfullMedia;
    if (featureOn('outer-screen-info')) {
      startOuterFeed();
    }
  }

  const STYLE = `
    #flipfull-outer-info {
      position: absolute; left: 0; bottom: 6%; width: 100%;
      display: flex; justify-content: center; align-items: center;
      font-size: 1.2rem; font-weight: 500; line-height: 1.6rem;
      color: var(--color-gs00, #fff); text-shadow: 0 0.1rem 0 rgba(0,0,0,0.3);
      pointer-events: none;
    }
    #flipfull-outer-info.hidden, #flipfull-outer-info > span.hidden { display: none; }
    #flipfull-outer-info > span { display: flex; align-items: center; margin: 0 0.4rem; }
    #flipfull-outer-info img { width: 1.6rem; height: 1.6rem; margin-right: 0.2rem; }
  `;

  function startRemote() {
    const info = { alarm: null, calls: 0, messages: 0 };
    const row = document.createElement('div');
    row.id = 'flipfull-outer-info';
    const items = {};
    [['alarm', 'http://clock.localhost/style/icons/clock_56.png'],
     ['calls', 'http://communications.localhost/resources/call_log_56.png'],
     ['messages', 'http://sms.localhost/resource/icons/sms_56.png']
    ].forEach(([name, icon]) => {
      const span = document.createElement('span');
      const img = document.createElement('img');
      img.src = icon;
      img.alt = '';
      span.appendChild(img);
      span.appendChild(document.createTextNode(''));
      row.appendChild(span);
      items[name] = span;
    });
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    function alarmText(time) {
      const date = new Date(time);
      if (isNaN(date) || date.getTime() < Date.now()) {
        return '';
      }
      const hm = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return date.getTime() - Date.now() > 20 * 3600 * 1000 ?
        `${date.toLocaleDateString([], { weekday: 'short' })} ${hm}` : hm;
    }

    function render() {
      const texts = {
        alarm: info.alarm ? alarmText(info.alarm) : '',
        calls: info.calls ? String(info.calls) : '',
        messages: info.messages ? String(info.messages) : ''
      };
      let any = false;
      Object.keys(items).forEach(name => {
        items[name].lastChild.textContent = texts[name];
        items[name].classList.toggle('hidden', !texts[name]);
        any = any || !!texts[name];
      });
      row.classList.toggle('hidden', !any);
      attach();
    }

    function attach() {
      const host = document.getElementById('default-screen');
      if (host && row.parentNode !== host) {
        host.appendChild(row);
      }
    }

    SettingsObserver.observe('next.alarm.info', '', value => {
      info.alarm = value && value.time ? value.time : null;
      render();
    });
    window.addEventListener(INFO_EVENT, evt => {
      const detail = evt.detail || {};
      info.calls = detail.calls || 0;
      info.messages = detail.messages || 0;
      render();
    });
    new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
    setInterval(render, 10 * 60 * 1000);
    render();
  }

  function start() {
    try {
      if (/index_remote\.html$/.test(location.pathname)) {
        if (featureOn('outer-screen-info')) {
          startRemote();
        }
      } else {
        startMain();
      }
    } catch (e) {
      log(`disabled: ${e}`);
    }
  }

  start();
}(window));

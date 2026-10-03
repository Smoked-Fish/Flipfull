'use strict';

(function (exports) {
  const INFO_EVENT = 'flipfull-outer-info';
  const MUSIC_EVENT = 'flipfull-now-playing';
  const TIMEOUT_SETTING = 'flipfull.subscreen.timeout';

  function featureOn(id) {
    return !!(window.FlipfullFeatures && window.FlipfullFeatures[id]);
  }

  function log(msg) {
    try {
      window.DumpOn ? window.DumpOn(`[Flipfull] ${msg}`) : dump(`[Flipfull] ${msg}\n`);
    } catch (e) { }
  }

  function manifestURL(name) {
    return window.AppOrigin ? window.AppOrigin.getManifestURL(name) : `http://${name}.localhost/manifest.webmanifest`;
  }

  function songPosition(p, playing, time) {
    return playing ? Math.min(p.duration, p.position + (time - p.at) / 1000 * p.rate) : p.position;
  }

  const SKIP = {
    'volume-up-button-press': 'media-next-track-button-press',
    'volume-down-button-press': 'media-previous-track-button-press'
  };
  const PLAY_PAUSE = 'media-play-pause-button-press';

  function playingApp() {
    let app = null;
    if (Service.query('contentChannelIsPlaying')) {
      core.audioChannelService._activeAudioChannels.forEach(channel => {
        if (!app && channel.isPlaying() && channel.name === 'content') {
          app = channel.app;
        }
      });
    }
    return app;
  }

  function sendMediaButton(app, message) {
    if (!app || !app.manifestUrl) {
      return false;
    }
    const origin = new URL(app.manifestUrl).origin;
    try {
      Components.classes['@mozilla.org/systemmessage-service;1']
        .getService(Components.interfaces.nsISystemMessageService)
        .sendMessage('media-button', { message }, origin);
    } catch (e) {
      log(`media-button to ${origin} failed: ${e}`);
      return false;
    }
    log(`${message} -> ${origin}`);
    return true;
  }

  let mediaApp = null;

  function watchMediaApp(changed) {
    window.addEventListener('audiochannelchanged', () => {
      const app = playingApp();
      if (app && app !== mediaApp) {
        mediaApp = app;
        changed();
      }
    });
    window.addEventListener('appterminated', evt => {
      if (evt.detail === mediaApp) {
        mediaApp = null;
        changed();
      }
    });
  }

  const passedKeys = {};
  let firstPressPlays = false;

  const FlipfullMedia = {
    hold(direction) {
      if (!featureOn('track-skip') || ScreenManager.lidOpened !== false) {
        return false;
      }
      if (!sendMediaButton(playingApp(), SKIP[direction])) {
        return false;
      }
      navigator.vibrate(50);
      return true;
    },

    passKey(evt) {
      if (evt.key !== 'AudioVolumeUp' && evt.key !== 'AudioVolumeDown') {
        return false;
      }
      if (evt.type === 'keydown') {
        passedKeys[evt.key] = featureOn('volume-keys') && !!Service.query('contentChannelIsPlaying');
      }
      return !!passedKeys[evt.key];
    },

    quickPress(screenWasOff, calling) {
      firstPressPlays = featureOn('play-pause-button') && ScreenManager.lidOpened === false &&
        !screenWasOff && !calling;
    },

    quickPresses(count) {
      if (count === 1 && firstPressPlays) {
        sendMediaButton(playingApp() || mediaApp, PLAY_PAUSE);
      }
      firstPressPlays = false;
    }
  };

  function nowPlayingFeed() {
    let controller = null;
    let listening = null;
    let playing = false;
    let position = null;

    function update() {
      const now = !!controller && controller.playbackState === 'playing';
      if (position && now !== playing) {
        const time = Date.now();
        position.position = songPosition(position, playing, time);
        position.at = time;
      }
      playing = now;
      const metadata = controller && controller.isActive ? controller.getMetadata() : null;
      const cover = metadata && metadata.artwork.length ? metadata.artwork[0].src : '';
      const detail = cover ? { cover, playing, ...(position || { duration: 0, position: 0, rate: 1, at: 0 }) } : null;
      ExternalScreenManager.send(new CustomEvent(MUSIC_EVENT, { detail }));
    }

    return function follow() {
      listening && listening.abort();
      controller = mediaApp && mediaApp.browser.element.mediaController;
      playing = false;
      position = null;
      if (controller) {
        listening = new AbortController();
        const signal = listening.signal;
        controller.addEventListener('positionstatechange', evt => {
          position = { duration: evt.duration, position: evt.position, rate: evt.playbackRate, at: Date.now() };
          update();
        }, { signal });
        ['activated', 'deactivated', 'metadatachange', 'playbackstatechange'].forEach(type =>
          controller.addEventListener(type, update, { signal }));
      }
      update();
    };
  }

  function startMain() {
    exports.FlipfullMedia = FlipfullMedia;
    if (featureOn('outer-screen-music')) {
      watchMediaApp(nowPlayingFeed());
    } else if (featureOn('play-pause-button')) {
      watchMediaApp(() => { });
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
    #flipfull-cover {
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background: center / cover no-repeat; pointer-events: none;
    }
    #flipfull-cover::after {
      content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.3);
    }
    #flipfull-progress {
      position: absolute; left: 0; bottom: 0; width: 100%; height: 0.3rem;
      background: rgba(255,255,255,0.3); pointer-events: none;
    }
    #flipfull-progress > div { width: 0; height: 100%; background: var(--color-gs00, #fff); }
    #flipfull-progress.paused > div { opacity: 0.5; }
    #flipfull-cover.hidden, #flipfull-progress.hidden { display: none; }
  `;

  const placers = [];

  function placeAll() {
    const host = document.getElementById('default-screen');
    if (host) {
      placers.forEach(place => place(host));
    }
  }

  function keepInDefaultScreen(place) {
    if (!placers.length) {
      new MutationObserver(placeAll).observe(document.body, { childList: true, subtree: true });
    }
    placers.push(place);
    placeAll();
  }

  function startInfoRow() {
    const info = { alarm: null };
    const row = document.createElement('div');
    row.id = 'flipfull-outer-info';

    const span = document.createElement('span');
    const img = document.createElement('img');
    img.src = 'http://clock.localhost/style/icons/clock_56.png';
    img.alt = '';
    span.appendChild(img);
    span.appendChild(document.createTextNode(''));
    row.appendChild(span);

    function alarmText(time) {
      const date = new Date(time);
      if (isNaN(date) || date.getTime() < Date.now()) {
        return '';
      }

      const hm = date.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
      });

      return date.getTime() - Date.now() > 20 * 3600 * 1000
        ? `${date.toLocaleDateString([], { weekday: 'short' })} ${hm}`
        : hm;
    }

    function render() {
      const text = info.alarm ? alarmText(info.alarm) : '';

      span.lastChild.textContent = text;
      span.classList.toggle('hidden', !text);
      row.classList.toggle('hidden', !text);
    }

    keepInDefaultScreen(host => row.parentNode === host || host.appendChild(row));

    SettingsObserver.observe('next.alarm.info', '', value => {
      info.alarm = value && value.time ? value.time : null;
      render();
    });

    setInterval(render, 10 * 60 * 1000);
    render();
  }

  function startCover() {
    const cover = document.createElement('div');
    cover.id = 'flipfull-cover';
    const bar = document.createElement('div');
    bar.id = 'flipfull-progress';
    bar.appendChild(document.createElement('div'));
    let song = null;
    let timer = null;

    function drawBar() {
      bar.firstChild.style.width = `${songPosition(song, song.playing, Date.now()) / song.duration * 100}%`;
    }

    function render() {
      const hasBar = !!song && song.duration > 0;
      cover.style.backgroundImage = song ? `url("${song.cover}")` : '';
      cover.classList.toggle('hidden', !song);
      bar.classList.toggle('hidden', !hasBar);
      bar.classList.toggle('paused', hasBar && !song.playing);
      clearInterval(timer);
      timer = null;
      if (hasBar) {
        drawBar();
        if (song.playing) {
          timer = setInterval(drawBar, 1000);
        }
      }
    }

    keepInDefaultScreen(host => {
      const mask = host.querySelector(':scope > #default-screen-gray-mask');
      if (mask && cover.parentNode !== host) {
        host.insertBefore(cover, mask);
      }
      if (bar.parentNode !== host) {
        host.appendChild(bar);
      }
    });
    window.addEventListener(MUSIC_EVENT, evt => {
      song = evt.detail;
      render();
    });
    render();
  }

  function startTimeout() {
    let seconds = null;
    SettingsObserver.observe(TIMEOUT_SETTING, null, value => {
      seconds = value;
    });
    exports.FlipfullOuterScreen = {
      stayOn: () => seconds === 0,
      dimAfter: (stock, dimFor) => (seconds ? Math.max(stock, seconds * 1000 - dimFor) : stock)
    };
  }

  function startRemote() {
    if (featureOn('outer-screen-timeout')) {
      startTimeout();
    }
    const info = featureOn('outer-screen-info');
    const music = featureOn('outer-screen-music');
    if (!info && !music) {
      return;
    }
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
    if (info) {
      startInfoRow();
    }
    if (music) {
      startCover();
    }
  }

  function start() {
    try {
      if (/index_remote\.html$/.test(location.pathname)) {
        startRemote();
      } else {
        startMain();
      }
    } catch (e) {
      log(`disabled: ${e}`);
    }
  }

  start();
}(window));

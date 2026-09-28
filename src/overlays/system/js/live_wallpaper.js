'use strict';

(function(exports) {
  const LIVE_KEY = 'wallpaper.live';
  const IMAGE_KEY = 'wallpaper.image';
  const LEGACY_VIDEO_KEY = 'wallpaper.video';
  const DM_KEY = 'dm.wallpaper.image';
  const POSTER_RE = /^\/sdcard\/\.wallpaper\/custom_wallpaper[^/]*\.jpg$/;
  const LEGACY_ANIMATED_RE = /^\/sdcard\/\.wallpaper\/[^/]+\.(gif|webp)$/i;
  const RELEASE_MS = 10000;

  function log(msg) {
    try {
      window.DumpOn ? window.DumpOn(`[LiveWallpaper] ${msg}`) : dump(`[LiveWallpaper] ${msg}\n`);
    } catch (e) {}
  }

  class Player {
    constructor(getHost) {
      this.getHost = getHost;
      this.url = null;
      this.kind = null;
      this.el = null;
      this.visible = false;
      this.failedUrl = null;
      this.releaseTimer = null;
    }

    set(url, kind) {
      if (url === this.url && kind === this.kind) {
        return;
      }
      this.destroy();
      this.url = url || null;
      this.kind = url ? kind : null;
      this.apply();
    }

    setVisible(visible) {
      visible = !!visible;
      if (visible !== this.visible) {
        this.visible = visible;
        log(visible ? 'play' : 'pause');
        this.apply();
      }
    }

    create() {
      const el = document.createElement(this.kind === 'video' ? 'video' : 'img');
      el.className = 'live-wallpaper';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;' +
        'object-fit:cover;pointer-events:none;';
      if (this.kind === 'video') {
        el.muted = true;
        el.defaultMuted = true;
        el.loop = true;
        el.preload = 'auto';
      }
      el.hidden = true;
      el.onerror = () => {
        if (!el.getAttribute('src')) {
          return;
        }
        log(`can't play ${this.url}; keeping the still wallpaper`);
        this.failedUrl = this.url;
        this.destroy();
      };
      return el;
    }

    apply() {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      if (!this.url || this.failedUrl === this.url) {
        this.destroy();
        return;
      }
      if (this.visible) {
        const host = this.getHost();
        if (!host) {
          return;
        }
        if (!this.el) {
          this.el = this.create();
        }
        if (this.el.parentNode !== host) {
          host.insertBefore(this.el, host.firstChild);
        }
        if (this.el.getAttribute('src') !== this.url) {
          this.el.src = this.url;
        }
        this.el.hidden = false;
        if (this.kind === 'video') {
          const playing = this.el.play();
          playing && playing.catch(e => log(`play() failed: ${e}`));
        }
      } else if (this.el) {
        if (this.kind === 'video') {
          this.el.pause();
          this.releaseTimer = setTimeout(() => this.unload(), RELEASE_MS);
        } else {
          this.unload();
        }
      }
    }

    unload() {
      if (!this.el) {
        return;
      }
      this.el.hidden = true;
      this.el.removeAttribute('src');
      if (this.kind === 'video') {
        this.el.load();
      }
    }

    destroy() {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      if (this.el) {
        this.unload();
        this.el.remove();
        this.el = null;
      }
    }
  }

  function powerManager() {
    return typeof PowerManager === 'undefined' ? null : PowerManager;
  }

  function readSdcardFile(path, attempt = 0) {
    return new Promise((resolve, reject) => {
      const storages = navigator.b2g.getDeviceStorages('sdcard');
      if (!storages.length) {
        if (attempt < 50) {
          setTimeout(() => readSdcardFile(path, attempt + 1).then(resolve, reject), 200);
        } else {
          reject(new Error('no sdcard storage'));
        }
        return;
      }
      const storage = storages.find(s => s.storageName === 'sdcard') || storages[0];
      const req = storage.get(path);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function startMain() {
    const player = new Player(() => document.getElementById('screen'));
    const values = { [LIVE_KEY]: '', [IMAGE_KEY]: '', [LEGACY_VIDEO_KEY]: '', [DM_KEY]: '' };
    let path = null;
    let url = null;
    let generation = 0;

    function visible() {
      if (window.ScreenManager && window.ScreenManager.screenEnabled === false) {
        return false;
      }
      const service = window.Service;
      if (!service || !service.query) {
        return false;
      }
      try {
        if (service.query('locked')) {
          return false;
        }
        const top = service.query('getTopMostWindow');
        return !!(top && top.isHomescreen);
      } catch (e) {
        return false;
      }
    }

    function update() {
      player.setVisible(visible());
    }

    function resolvePath() {
      const image = values[IMAGE_KEY];
      if (values[DM_KEY]) {
        return '';
      }
      if (POSTER_RE.test(image)) {
        return values[LIVE_KEY] || values[LEGACY_VIDEO_KEY] || '';
      }
      return LEGACY_ANIMATED_RE.test(image) ? image : '';
    }

    function publish(newUrl, kind) {
      const old = url;
      url = newUrl;
      player.set(newUrl, kind);
      update();
      if (window.ExternalScreenManager) {
        window.ExternalScreenManager.send(new CustomEvent('livewallpaperchange',
          { detail: { url: newUrl, kind } }));
      }
      if (old) {
        setTimeout(() => URL.revokeObjectURL(old), 5000);
      }
    }

    function reload() {
      const next = resolvePath();
      if (next === path) {
        return;
      }
      path = next;
      const mine = ++generation;
      if (!next) {
        log('no live wallpaper');
        publish(null, null);
        return;
      }
      readSdcardFile(next).then(file => {
        if (mine !== generation) {
          return;
        }
        const kind = /\.mp4$/i.test(next) || /^video\//.test(file.type) ? 'video' : 'image';
        log(`live wallpaper ${next} (${kind})`);
        publish(URL.createObjectURL(file), kind);
      }, err => {
        if (mine === generation) {
          log(`can't read ${next}: ${err}`);
          publish(null, null);
        }
      });
    }

    Object.keys(values).forEach(key => {
      SettingsObserver.observe(key, '', value => {
        values[key] = key === DM_KEY ? (value ? 'on' : '') : (typeof value === 'string' ? value : '');
        reload();
      });
    });

    ['screenchange', 'hierarchytopmostwindowchanged', 'homescreen-ready',
     'homescreenopened', 'appopened', 'appclosed', 'appterminated',
     'attentionopened', 'attentionclosed', 'lockscreen-appopened',
     'lockscreen-appclosing', 'lockscreen-appclosed'
    ].forEach(type => window.addEventListener(type, update));

    const pm = powerManager();
    if (pm && typeof pm.setScreenEnabled === 'function') {
      const setScreenEnabled = pm.setScreenEnabled;
      pm.setScreenEnabled = function(...args) {
        const result = setScreenEnabled.apply(this, args);
        Promise.resolve().then(update);
        return result;
      };
    }
    update();
  }

  function startRemote() {
    const player = new Player(() => document.getElementById('default-screen'));
    const pm = powerManager();
    let lit = pm && pm.getExtScreenState ? !!pm.getExtScreenState() : false;
    let watched = null;
    const classWatcher = new MutationObserver(() => update());

    function visible() {
      const host = document.getElementById('default-screen');
      if (host !== watched) {
        classWatcher.disconnect();
        watched = host;
        host && classWatcher.observe(host, { attributes: true, attributeFilter: ['class'] });
      }
      return !!(lit && host && host.classList.contains('show'));
    }

    function update() {
      player.setVisible(visible());
    }

    if (pm && typeof pm.setExtScreenEnabled === 'function') {
      const setExtScreenEnabled = pm.setExtScreenEnabled;
      pm.setExtScreenEnabled = function(enabled, ...rest) {
        lit = !!enabled;
        const result = setExtScreenEnabled.call(this, enabled, ...rest);
        update();
        return result;
      };
    }

    window.addEventListener('livewallpaperchange', evt => {
      const detail = evt.detail || {};
      player.set(detail.url || null, detail.kind || null);
      update();
    });
    update();
  }

  function start() {
    if (!(window.FlipfullFeatures && window.FlipfullFeatures['live-wallpaper'])) {
      return;
    }
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

  exports.LiveWallpaper = { start, Player };
  start();
}(window));

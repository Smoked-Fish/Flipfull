'use strict';

function FlipfullMapsPage(pageCss, navCss) {
  const root = document.documentElement;
  if (root.hasAttribute('data-flipfull')) {
    return false;
  }
  root.setAttribute('data-flipfull', '');

  const style = document.createElement('style');
  style.textContent = pageCss;
  (document.head || root).appendChild(style);

  const ACCOUNT = /^Signed in as |\S+@\S+\.\S+/;

  function watchSnackbar(bar) {
    const check = () => bar.toggleAttribute('data-flipfull-hidden', ACCOUNT.test(bar.textContent.trim()));
    new MutationObserver(check).observe(bar, { childList: true, subtree: true, characterData: true });
    check();
  }

  const snackbar = document.querySelector('.ml-snackbar-container');
  if (snackbar) {
    watchSnackbar(snackbar);
  } else {
    new MutationObserver((records, observer) => {
      const bar = document.querySelector('.ml-snackbar-container');
      if (bar) {
        observer.disconnect();
        watchSnackbar(bar);
      }
    }).observe(root, { childList: true, subtree: true });
  }

  const seen = { directions: [], tiles: null, routeTiles: null };
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const url = entry.name;
      if (url.includes('/maps/preview/directions?')) {
        seen.directions = seen.directions.filter(u => u !== url).slice(-4).concat([url]);
      } else if (url.includes('/maps/vt?') && url.includes('!4e0') && /!1i\d+!2i\d+!3i\d+!4i256/.test(url)) {
        if (url.includes('!2sdirections!')) {
          seen.routeTiles = url;
        } else if (url.includes('!2sm!')) {
          seen.tiles = url;
        }
      }
    }
  }).observe({ type: 'resource', buffered: true });

  async function get(url, retry = true) {
    let response;
    try {
      response = await fetch(url);
    } catch (e) {
      if (!retry) {
        throw e;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      return get(url, false);
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
  }

  async function loadRoute({ mode, card }) {
    for (const url of seen.directions.slice().reverse()) {
      const route = MapsRoute.chooseRoute(MapsRoute.parseDirections(await get(url)), mode, card);
      if (route) {
        return { route, url };
      }
    }
    throw new Error(seen.directions.length ? `no ${mode} route in the directions` : 'no directions loaded');
  }

  const ARROW = 'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';
  const SHAPES = {
    straight: `<path ${ARROW} d="M12 21V7"/><path fill="currentColor" d="M12 2l-6 7h12z"/>`,
    turn: `<path ${ARROW} d="M7 21v-8a4 4 0 0 1 4-4h5"/><path fill="currentColor" d="M22 9l-7-6v12z"/>`,
    slight: `<path ${ARROW} d="M8 21v-6l7-7"/><path fill="currentColor" d="M20 3l-9.2 1.4 7.8 7.8z"/>`,
    sharp: `<path ${ARROW} d="M8 3v9l7 7"/><path fill="currentColor" d="M20 21l-1.4-9.2-7.8 7.8z"/>`,
    uturn: `<path ${ARROW} d="M17 21V9a4.5 4.5 0 0 0-9 0v7"/><path fill="currentColor" d="M8 22l-6-7h12z"/>`,
    roundabout: `<circle ${ARROW} cx="12" cy="11" r="4"/><path ${ARROW} d="M12 21v-6M15 8l3-3"/>` +
      '<path fill="currentColor" d="M21 2l-8.5 2.4 6.1 6.1z"/>',
    merge: `<path ${ARROW} d="M6 21c0-6 6-7 6-12V7M18 21c0-6-6-7-6-12"/><path fill="currentColor" d="M12 2l-6 7h12z"/>`,
    destination: '<path fill="currentColor" d="M12 2C8.1 2 5 5.1 5 9c0 5.3 7 13 7 13s7-7.7 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>',
  };

  function icon(maneuver) {
    const shape = maneuver === 'destination' ? 'destination' :
      /uturn/.test(maneuver) ? 'uturn' :
      /roundabout/.test(maneuver) ? 'roundabout' :
      /merge/.test(maneuver) ? 'merge' :
      /sharp/.test(maneuver) ? 'sharp' :
      /slight|keep|fork|ramp/.test(maneuver) ? 'slight' :
      /turn/.test(maneuver) ? 'turn' : 'straight';
    const mirror = shape === 'uturn' ? /right/.test(maneuver) : /left/.test(maneuver);
    return `<svg viewBox="0 0 24 24"${mirror ? ' style="transform:scaleX(-1)"' : ''}>${SHAPES[shape]}</svg>`;
  }

  const SCREEN = `
    <div class="fn-head">
      <div class="fn-icon"></div>
      <div class="fn-what">
        <div class="fn-dist"><b></b><span></span></div>
        <div class="fn-text"></div>
      </div>
    </div>
    <div class="fn-then">Then <span></span></div>
    <div class="fn-map">
      <div class="fn-tiles"></div>
      <svg class="fn-line"><path/><circle r="5"/></svg>
      <div class="fn-me"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 5l5 12-5-3-5 3z"/></svg></div>
      <div class="fn-msg"></div>
    </div>
    <div class="fn-foot"><b class="fn-eta"></b><span class="fn-left"></span></div>
    <ol class="fn-steps"></ol>
    <div class="fn-keys"><span>Steps</span><span class="fn-mute"></span><span>End</span></div>`;

  const MUTE_KEY = 'flipfull.maps.muted';
  const ZOOMS = [13, 18];
  const SOFTKEYS = { 112: 'SoftLeft', 114: 'SoftRight' };
  const SYSTEM_KEYS = new Set(['AudioVolumeUp', 'AudioVolumeDown', 'EndCall', 'MicrophoneToggle']);

  let nav = null;

  class Nav {
    constructor() {
      this.frame = document.createElement('iframe');
      this.frame.id = 'flipfull-nav';
      document.body.appendChild(this.frame);
      this.win = this.frame.contentWindow;
      this.doc = this.frame.contentDocument;
      const sheet = this.doc.createElement('style');
      sheet.textContent = navCss;
      this.doc.head.appendChild(sheet);
      this.doc.body.innerHTML = SCREEN;
      const $ = selector => this.doc.querySelector(selector);
      this.ui = {
        icon: $('.fn-icon'), number: $('.fn-dist b'), unit: $('.fn-dist span'), text: $('.fn-text'),
        then: $('.fn-then'), thenIcon: $('.fn-then span'), map: $('.fn-map'), tiles: $('.fn-tiles'),
        svg: $('.fn-line'), line: $('.fn-line path'), dot: $('.fn-line circle'), me: $('.fn-me'), msg: $('.fn-msg'),
        eta: $('.fn-eta'), left: $('.fn-left'), steps: $('.fn-steps'), mute: $('.fn-mute'),
      };
      this.tiles = new Map();
      this.watch = null;
      this.fix = null;
      this.state = null;
      this.backArmed = 0;
      this.noticeUntil = 0;
      this.rerouting = false;
      this.reroutedAt = 0;
      try {
        this.muted = localStorage.getItem(MUTE_KEY) === '1';
      } catch (e) {
        this.muted = false;
      }
      this.ui.mute.textContent = this.muted ? 'Sound' : 'Mute';

      this.win.addEventListener('keydown', evt => {
        if (!SYSTEM_KEYS.has(evt.key)) {
          evt.preventDefault();
          this.key(SOFTKEYS[evt.keyCode] || evt.key);
        }
      }, true);
      this.win.addEventListener('blur', () => setTimeout(() => nav === this && this.win.focus()));
      this.win.focus();
    }

    async start(screen) {
      root.setAttribute('data-flipfull-nav', 'on');
      this.message('Loading route…');
      let loaded;
      try {
        loaded = await loadRoute(screen);
      } catch (e) {
        console.error(`[Flipfull maps] route: ${e}`);
        this.stop();
        return false;
      }
      if (nav !== this) {
        return true;
      }
      this.url = loaded.url;
      this.setRoute(loaded.route, seen.routeTiles);
      this.zoom = this.guidance.tune.zoom;
      this.message('Waiting for GPS…');
      this.watch = navigator.geolocation.watchPosition(
        position => this.onFix(position.coords),
        error => this.message(error.code === error.PERMISSION_DENIED ?
          'Maps may not use your location (Settings > Privacy)' : 'Waiting for GPS…'),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
      return true;
    }

    stop() {
      nav = null;
      if (this.watch !== null) {
        navigator.geolocation.clearWatch(this.watch);
        this.watch = null;
      }
      if (window.speechSynthesis) {
        speechSynthesis.cancel();
      }
      this.frame.remove();
      root.removeAttribute('data-flipfull-nav');
    }

    setRoute(route, routeTiles) {
      this.route = route;
      this.routeTiles = routeTiles;
      this.guidance = new MapsRoute.Guidance(route);
      this.ui.svg.classList.toggle('fn-chain', !routeTiles);
      this.tiles.forEach(tile => tile.remove());
      this.tiles.clear();
      this.ui.steps.textContent = '';
      route.steps.concat([{ text: route.dest.name, maneuver: 'destination' }]).forEach(step => {
        const li = this.doc.createElement('li');
        li.innerHTML = icon(step.maneuver);
        const text = this.doc.createElement('span');
        text.textContent = step.text;
        li.appendChild(text);
        if (step.meters) {
          const dist = this.doc.createElement('small');
          dist.textContent = MapsRoute.distanceParts(step.meters, route.imperial).join(' ');
          li.appendChild(dist);
        }
        this.ui.steps.appendChild(li);
      });
    }

    message(text) {
      this.ui.msg.textContent = text || '';
      this.ui.msg.hidden = !text;
    }

    notice(text) {
      this.noticeUntil = Date.now() + 3000;
      this.message(text);
    }

    onFix(coords) {
      if (!this.watch) {
        return;
      }
      const fix = {
        lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy,
        speed: coords.speed, heading: coords.heading,
      };
      const state = this.guidance.update(fix);
      this.fix = fix;
      this.state = state;
      if (!this.rerouting && Date.now() > this.noticeUntil) {
        this.message(fix.accuracy > 80 ? 'Weak GPS signal' : null);
      }
      this.render();
      if (state.speak) {
        this.prompt(state.speak, state.buzz);
      }
      if (state.offRoute) {
        this.reroute(fix);
      }
      if (state.arrived) {
        navigator.geolocation.clearWatch(this.watch);
        this.watch = null;
        root.removeAttribute('data-flipfull-nav');
      }
    }

    prompt(text, buzz) {
      if (this.muted) {
        return;
      }
      if (buzz) {
        navigator.vibrate([150, 100, 150]);
      }
      if (window.speechSynthesis && speechSynthesis.getVoices().length) {
        speechSynthesis.cancel();
        speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      }
    }

    async reroute(fix) {
      if (this.rerouting || Date.now() - this.reroutedAt < 15000) {
        return;
      }
      this.rerouting = true;
      this.message('Rerouting…');
      try {
        const text = await get(MapsRoute.rerouteUrl(this.url, fix.lat, fix.lng));
        const route = MapsRoute.chooseRoute(MapsRoute.parseDirections(text), this.route.mode, '');
        if (!route) {
          throw new Error('no route');
        }
        this.setRoute(route, null);
        this.message(null);
      } catch (e) {
        console.error(`[Flipfull maps] reroute: ${e}`);
        this.notice('No new route yet');
      }
      this.rerouting = false;
      this.reroutedAt = Date.now();
    }

    render() {
      const { state, route, ui } = this;
      const [number, unit] = MapsRoute.distanceParts(state.toNext, route.imperial);
      ui.number.textContent = state.arrived ? '' : number;
      ui.unit.textContent = state.arrived ? 'Arrived' : unit;
      ui.text.textContent = state.arrived ? route.dest.name : state.text;
      ui.icon.innerHTML = icon(state.arrived ? 'destination' : state.maneuver);
      ui.then.hidden = !state.then || state.arrived;
      ui.thenIcon.innerHTML = state.then ? icon(state.then) : '';
      const eta = new Date(Date.now() + state.seconds * 1000);
      ui.eta.textContent = eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      ui.left.textContent = state.arrived ? '' :
        `${MapsRoute.formatDuration(state.seconds)} · ${MapsRoute.distanceParts(state.metres, route.imperial).join(' ')}`;
      Array.prototype.forEach.call(ui.steps.children, (li, i) => {
        li.classList.toggle('fn-done', i < state.next - 1);
        li.classList.toggle('fn-current', i === state.next);
      });
      this.drawMap();
    }

    drawMap() {
      const { fix, state, ui, zoom } = this;
      const width = ui.map.clientWidth;
      const height = ui.map.clientHeight;
      const me = MapsRoute.worldPixel(fix.lat, fix.lng, zoom);
      const left = me.x - width / 2;
      const top = me.y - height * 0.62;

      const wanted = new Set();
      const template = this.routeTiles || seen.tiles;
      if (template) {
        const count = 2 ** zoom;
        for (let y = Math.floor(top / 256); y * 256 < top + height; y++) {
          for (let x = Math.floor(left / 256); x * 256 < left + width; x++) {
            const key = `${zoom}/${x}/${y}`;
            wanted.add(key);
            let tile = this.tiles.get(key);
            if (!tile) {
              tile = this.doc.createElement('img');
              tile.className = 'fn-tile';
              tile.src = MapsRoute.tileUrl(template, zoom, ((x % count) + count) % count, y);
              tile.addEventListener('error', () => {
                tile.remove();
                this.tiles.delete(key);
              });
              ui.tiles.appendChild(tile);
              this.tiles.set(key, tile);
            }
            tile.style.transform = `translate(${Math.round(x * 256 - left)}px, ${Math.round(y * 256 - top)}px)`;
          }
        }
      }
      this.tiles.forEach((tile, key) => {
        if (!wanted.has(key)) {
          tile.remove();
          this.tiles.delete(key);
        }
      });

      const toScreen = p => {
        const w = MapsRoute.worldPixel(p.lat, p.lng, zoom);
        return [Math.round(w.x - left), Math.round(w.y - top)];
      };
      const ahead = this.guidance.points.slice(state.next);
      ui.line.setAttribute('d', `M${[fix].concat(ahead).map(toScreen).join('L')}`);
      const [dx, dy] = toScreen(ahead[0]);
      ui.dot.setAttribute('cx', dx);
      ui.dot.setAttribute('cy', dy);

      const heading = fix.speed > 1 && fix.heading !== null && !isNaN(fix.heading) ? fix.heading : state.heading;
      ui.me.style.transform = `translate(${Math.round(width / 2) - 12}px, ${Math.round(height * 0.62) - 12}px) rotate(${Math.round(heading)}deg)`;
    }

    key(name) {
      const steps = this.ui.steps;
      const body = this.doc.body;
      const listing = body.classList.contains('fn-listing');
      switch (name) {
        case 'SoftLeft':
          body.classList.toggle('fn-listing');
          if (!listing && this.state) {
            const current = steps.children[this.state.next];
            steps.scrollTop = current ? current.offsetTop - 40 : 0;
          }
          break;
        case 'Enter':
          this.muted = !this.muted;
          this.ui.mute.textContent = this.muted ? 'Sound' : 'Mute';
          try {
            localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
          } catch (e) {}
          if (this.muted && window.speechSynthesis) {
            speechSynthesis.cancel();
          }
          break;
        case 'SoftRight':
          this.stop();
          break;
        case 'Backspace':
          if (listing) {
            body.classList.remove('fn-listing');
          } else if (Date.now() - this.backArmed < 3000 || !this.watch) {
            this.stop();
          } else {
            this.backArmed = Date.now();
            this.notice('Press Back again to end');
          }
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          if (listing) {
            steps.scrollTop += name === 'ArrowUp' ? -48 : 48;
          } else if (this.fix) {
            const z = this.zoom + (name === 'ArrowUp' ? 1 : -1);
            this.zoom = Math.max(ZOOMS[0], Math.min(ZOOMS[1], z));
            this.drawMap();
          }
          break;
      }
    }
  }

  function routeScreen() {
    const go = document.querySelector('button[jsaction^="tinymenubar.last"]');
    const mode = MapsRoute.modeFromUrl(location.href);
    if (!location.pathname.startsWith('/maps/dir/') || !go || go.textContent.trim() !== 'Go' ||
        !MapsRoute.TUNING[mode]) {
      return null;
    }
    const pane = document.querySelector('.ml-pane-container');
    return { mode, card: pane ? pane.textContent : '' };
  }

  let screenNow = null;
  let screenLeft = { at: -Infinity, screen: null };
  new MutationObserver(() => {
    const screen = routeScreen();
    if (screenNow && !screen) {
      screenLeft = { at: performance.now(), screen: screenNow };
    }
    screenNow = screen;
  }).observe(root, { childList: true, subtree: true, characterData: true });
  screenNow = routeScreen();

  window.addEventListener('keydown', evt => {
    const screen = !nav && (SOFTKEYS[evt.keyCode] || evt.key) === 'SoftRight' &&
      (screenNow || (screenLeft.at >= evt.timeStamp ? screenLeft.screen : null));
    if (!screen) {
      return;
    }
    if (!location.pathname.startsWith('/maps/dir/')) {
      history.back();
    }
    nav = new Nav();
    nav.start(screen).then(started => {
      if (!started) {
        document.querySelector('button[jsaction^="tinymenubar.last"]').click();
      }
    });
  }, true);

  return true;
}

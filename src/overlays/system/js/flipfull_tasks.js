'use strict';

// app switcher, a keypad rework of the task manager in the KaiOS 2.5.4 8110 system app
// (github.com/dotrihoang2012/KaiOS-2.5.4-in-nokia-8110-4G, MIT)
(function () {
    if (!(window.FlipfullFeatures && window.FlipfullFeatures['app-switcher'])) {
        return;
    }

    const HIDDEN_ROLES = ['system', 'homescreen', 'input', 'theme', 'addon'];

    // the 8110's cards_view.css, cut down
    const CSS = `
#flipfull-tasks { position: absolute; inset: 0; z-index: 65535; visibility: hidden; overflow: hidden;
  background: rgba(0, 0, 0, 0.45); outline: none; color: #fff; -moz-user-select: none; }
#flipfull-tasks.active { visibility: visible; }
#screen.flipfull-tasks #windows { filter: blur(10px); }
#flipfull-tasks .card { position: absolute; top: 30%; left: 26%; width: 48%; height: 45%; }
#flipfull-tasks .card.closing { transform: translateY(-100vh) !important; opacity: 0;
  transition: transform 200ms ease-out, opacity 200ms ease-out; }
#flipfull-tasks .shot { width: 100%; height: 100%; background: #fff center / 4rem no-repeat; }
#flipfull-tasks .shot.screenshot { background-size: 100% 100%; background-position: left top; }
#flipfull-tasks .title { position: absolute; top: -4rem; left: 0; width: 100%; height: 2rem; line-height: 2rem;
  margin: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center;
  font-size: 1.4rem; font-weight: 300; font-style: italic; }
#flipfull-tasks .tray { position: absolute; bottom: 0; left: 0; width: 100%; height: 3rem; background: rgb(95, 95, 95); }
#flipfull-tasks .close { position: absolute; left: 0; top: 0; width: 20%; height: 100%;
  text-align: center; line-height: 3rem; font-size: 2.2rem; }
#flipfull-tasks .icon { position: absolute; top: 1rem; left: calc(50% - 2rem); width: 4rem; height: 4rem;
  background: center / cover no-repeat; }
#flipfull-tasks .card:not(.current) .icon { visibility: hidden; }
#flipfull-tasks footer { position: absolute; bottom: 0; left: 0; right: 0; display: flex; height: 3rem;
  line-height: 3rem; padding: 0 0.6rem; background: #1e1e26; font-size: 1.4rem; font-weight: 600; }
#flipfull-tasks footer span { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#flipfull-tasks footer .center { text-align: center; text-transform: uppercase; }
#flipfull-tasks footer .right { text-align: right; }
`;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const view = document.createElement('div');
    view.id = 'flipfull-tasks';
    view.tabIndex = -1;
    view.innerHTML = '<div class="cards"></div><footer><span>Close</span><span class="center">Open</span>' +
        '<span class="right">Close all</span></footer>';
    document.body.appendChild(view);
    const deck = view.firstChild;

    // when each app was last opened, and a picture of it from when it was last on screen
    const opened = {};
    const shots = {};
    // { app, el } while the switcher is up
    let cards = [];
    let position = 0;

    function listed(app) {
        return !app.isDead() && !app.isHomescreen && !HIDDEN_ROLES.includes(app.manifest && app.manifest.role);
    }

    function snap(app) {
        return app.iframe.getScreenshot(innerWidth, innerHeight, 'image/jpeg').then(blob => {
            const id = app.instanceID;
            if (blob && blob.size && !app.isDead()) {
                shots[id] && URL.revokeObjectURL(shots[id]);
                shots[id] = URL.createObjectURL(blob);
            }
        }, () => { });
    }

    function newCard(app) {
        const el = document.createElement('div');
        el.className = 'card';
        el.innerHTML = '<h1 class="title"></h1><div class="shot"></div>' +
            '<div class="tray"><span class="close">✕</span><span class="icon"></span></div>';
        el.querySelector('.title').textContent = app.shortName || app.name || app.origin;
        const icon = app.config.icon || app.getIconForSplash();
        if (icon) {
            el.querySelector('.icon').style.backgroundImage = `url("${icon}")`;
            el.querySelector('.shot').style.backgroundImage = `url("${icon}")`;
        }
        return { app, el };
    }

    function place() {
        cards.forEach(({ el }, i) => {
            const offset = i - position;
            el.classList.toggle('current', offset === 0);
            el.style.visibility = Math.abs(offset) > 1 ? 'hidden' : '';
            el.style.transform = `translateX(${offset * 115}%)`;
        });
    }

    function drawShots() {
        cards.forEach(({ app, el }) => {
            const url = shots[app.instanceID];
            if (url) {
                const shot = el.querySelector('.shot');
                shot.classList.add('screenshot');
                shot.style.backgroundImage = `url("${url}")`;
            }
        });
    }

    function active() {
        return view.classList.contains('active');
    }

    function show() {
        cards = Object.values(appWindowManager.getApps()).filter(listed)
            .sort((a, b) => (opened[b.instanceID] || 0) - (opened[a.instanceID] || 0))
            .map(newCard);
        if (!cards.length) {
            return;
        }
        cards.forEach(({ el }) => deck.appendChild(el));
        // start on the app before this one, like alt-tab
        position = cards.length > 1 && cards[0].app === Service.currentApp ? 1 : 0;
        place();
        drawShots();
        view.classList.add('active');
        document.getElementById('screen').classList.add('flipfull-tasks');
        window.dispatchEvent(new CustomEvent('flipfulltasks-activated'));
        navigator.vibrate(50);
        cards.forEach(({ app }) => snap(app).then(drawShots));
    }

    // leaving the hierarchy gives focus back to the app on screen
    function hide() {
        if (!active()) {
            return;
        }
        view.classList.remove('active');
        document.getElementById('screen').classList.remove('flipfull-tasks');
        window.dispatchEvent(new CustomEvent('flipfulltasks-deactivated'));
        deck.innerHTML = '';
        cards = [];
    }

    function open(app) {
        hide();
        app === Service.currentApp || appWindowManager.display(app, 'immediate', 'immediate');
    }

    function goHome() {
        hide();
        appWindowManager.display(null, null, null, 'home');
    }

    function move(by) {
        position = Math.max(0, Math.min(cards.length - 1, position + by));
        place();
    }

    function close() {
        const app = cards[position].app;
        app.killable() && app.kill();
    }

    function closeAll() {
        const apps = cards.map(card => card.app);
        hide();
        apps.forEach(app => app.killable() && app.kill());
        appWindowManager.display(null, null, null, 'home');
    }

    function dropCard(app) {
        const i = cards.findIndex(card => card.app === app);
        if (i < 0) {
            return;
        }
        const el = cards.splice(i, 1)[0].el;
        el.classList.add('closing');
        setTimeout(() => el.remove(), 200);
        if (!cards.length) {
            goHome();
            return;
        }
        if (i < position || position === cards.length) {
            position--;
        }
        place();
    }

    const ACTIONS = {
        ArrowLeft: () => move(-1),
        ArrowRight: () => move(1),
        ArrowUp: close,
        ArrowDown: () => { },
        SoftLeft: close,
        SoftRight: closeAll,
        Enter: () => open(cards[position].app),
        Backspace: () => open(Service.currentApp),
        GoBack: () => open(Service.currentApp),
        EndCall: goHome
    };

    function onKey(evt) {
        const action = ACTIONS[evt.key];
        if (!action || !active()) {
            return;
        }
        evt.preventDefault();
        evt.stopPropagation();
        // Back acts on release, or its keyup would reach the app and go back there too
        const back = evt.key === 'Backspace' || evt.key === 'GoBack';
        if ((evt.type === 'keyup') === back) {
            action();
        }
    }

    view.addEventListener('keydown', onKey, true);
    view.addEventListener('keyup', onKey, true);
    window.addEventListener('appopened', evt => {
        opened[evt.detail.instanceID] = Date.now();
    });
    window.addEventListener('appwillclose', evt => listed(evt.detail) && snap(evt.detail));
    window.addEventListener('appterminated', evt => {
        const id = evt.detail.instanceID;
        shots[id] && URL.revokeObjectURL(shots[id]);
        delete shots[id];
        delete opened[id];
        dropCard(evt.detail);
    });

    window.addEventListener('appopen', evt => evt.detail.isHomescreen || hide());
    ['home', 'attentionopened', 'lockscreen-appopened'].forEach(type => window.addEventListener(type, hide));
    Service.request('registerHierarchy', {
        name: 'FlipfullTasks',
        EVENT_PREFIX: 'flipfulltasks',
        isActive: active,
        setHierarchy: top => top && view.focus()
    });

    const KEY_SETTING = 'flipfull.tasks.key';
    const HOLD_HOME = 500;
    // apps that use the button themselves keep it
    const KEY_USERS = {}; // todo gba app
    let switchKey = 'favoritecontacts';
    let pressed = false;
    let holdTimer = null;

    function canSwitch() {
        if (ScreenManager.lidOpened === false || !ScreenManager.screenEnabled || Service.query('locked') ||
            Service.query('isFtuRunning') || (window.hardwareButtons && hardwareButtons._isCalling)) {
            return false;
        }

        const app = Service.currentApp;
        const url = (!active() && app && app.manifestUrl) || '';
        return !(KEY_USERS[switchKey] || []).some(origin => url.includes(origin));
    }

    function onSwitchKey(evt) {
        if (!evt.key || evt.key.toLowerCase() !== switchKey) {
            return;
        }
        if (evt.type === 'keydown') {
            if (!pressed) {
                if (!canSwitch()) {
                    return;
                }
                pressed = true;
                holdTimer = setTimeout(() => {
                    holdTimer = null;
                    navigator.vibrate(50);
                    goHome();
                }, HOLD_HOME);
            }
        } else {
            if (!pressed) {
                return;
            }
            pressed = false;
            if (holdTimer) {
                clearTimeout(holdTimer);
                holdTimer = null;
                if (active()) {
                    open(Service.currentApp);
                } else {
                    show();
                }
            }
        }
        evt.preventDefault();
        evt.stopImmediatePropagation();
    }

    SettingsObserver.observe(KEY_SETTING, 'qdcall', value => {
        switchKey = value || 'qdcall';
    });
    window.addEventListener('keydown', onSwitchKey, true);
    window.addEventListener('keyup', onSwitchKey, true);
}());

'use strict';

(function () {
    const $ = (id) => document.getElementById(id);
    const el = {
        body: document.body, bar: $('bar'), barTitle: $('bar-title'), loadingText: $('loading-text'),
        offlineWhy: $('offline-why'), list: $('list'), games: $('games'), screen: $('screen'), fps: $('fps'),
        menuItems: $('menu-items'), softkeys: $('softkeys'), left: $('sk-left'), center: $('sk-center'),
        right: $('sk-right'),
    };
    const FOLDER = 'games';
    const B = 0;
    const SELECT = 2;
    const START = 3;
    const UP = 4;
    const DOWN = 5;
    const LEFT = 6;
    const RIGHT = 7;
    const A = 8;
    const L = 10;
    const R = 11;
    const KEYS = {
        ArrowUp: UP, 2: UP, ArrowDown: DOWN, 8: DOWN, ArrowLeft: LEFT, 4: LEFT, ArrowRight: RIGHT, 6: RIGHT,
        Enter: A, 5: A, 0: B, 7: B, 1: L, 3: R, 9: START, '*': SELECT,
    };

    let view = 'loading';
    let keys = {};
    let games = [];
    const focus = { list: 0, menu: 0 };
    let current = null;
    let player = null;
    let held = 0;

    function storage() {
        return navigator.b2g.getDeviceStorage('sdcard');
    }

    function done(req) {
        if (req.then) {
            return req;
        }
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function stored(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function store(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {}
    }

    function softkeys(left, center, right) {
        el.left.textContent = left || '';
        el.center.textContent = center || '';
        el.right.textContent = right || '';
    }

    function row(name, detail) {
        const div = document.createElement('div');
        div.className = 'row';
        const n = document.createElement('span');
        n.className = 'name';
        n.textContent = name;
        div.appendChild(n);
        if (detail) {
            const d = document.createElement('span');
            d.className = 'detail';
            d.textContent = detail;
            div.appendChild(d);
        }
        return div;
    }

    function moveFocus(name, box, step) {
        const rows = Array.from(box.querySelectorAll('.row'));
        if (!rows.length) {
            return;
        }
        focus[name] = step ? (focus[name] + step + rows.length) % rows.length : Math.min(focus[name], rows.length - 1);
        rows.forEach((r, i) => r.classList.toggle('focus', i === focus[name]));
        rows[focus[name]].scrollIntoView({ block: 'nearest' });
    }

    function show(name, text) {
        view = name;
        el.body.dataset.view = name;
        if (name === 'loading') {
            el.loadingText.textContent = text || 'Loading…';
        }
        render();
    }

    function render() {
        switch (view) {
            case 'list': return renderList();
            case 'play': return renderPlay();
            case 'menu': return renderMenu();
            case 'offline':
                el.barTitle.textContent = 'GBA';
                keys = { center: connect, back: () => window.close() };
                return softkeys('', 'Retry', '');
            default:
                el.barTitle.textContent = 'GBA';
                keys = {};
                return softkeys('', '', '');
        }
    }

    function failed(e) {
        el.offlineWhy.textContent = (e && e.message) || String(e);
        show('offline');
    }

    async function scan() {
        const found = [];
        const cursor = storage().enumerate(FOLDER);
        for await (const file of cursor.values()) {
            const name = file.name.replace(/^.*\//, '');
            if (/\.gba$/i.test(name)) {
                found.push({ path: file.name, title: name.replace(/\.gba$/i, '') });
            }
        }
        return found.sort((a, b) => a.title.localeCompare(b.title));
    }

    function renderList() {
        el.barTitle.textContent = 'GBA';
        el.list.classList.toggle('empty', !games.length);
        el.games.textContent = '';
        games.forEach((g) => el.games.appendChild(row(g.title)));
        moveFocus('list', el.games, 0);
        keys = {
            center: () => games[focus.list] && start(games[focus.list]),
            back: () => window.close(),
        };
        softkeys('', games.length ? 'Play' : '', '');
    }

    function savePath(game) {
        return game.path.replace(/\.gba$/i, '.sav');
    }

    async function readFile(path) {
        try {
            const file = await done(storage().get(path));
            return new Uint8Array(await file.arrayBuffer());
        } catch (e) {
            return new Uint8Array(0);
        }
    }

    async function writeFile(path, data) {
        const s = storage();
        try {
            await done(s.delete(path));
        } catch (e) {}
        await done(s.addNamed(new Blob([data]), path));
    }

    async function writeSave() {
        if (current) {
            await writeFile(savePath(current), await window.FlipfullRetro.save());
        }
    }

    function fit(width, height) {
        const room = window.innerHeight - el.bar.offsetHeight - el.softkeys.offsetHeight;
        const scale = Math.max(1, Math.min(window.innerWidth / width, room / height));
        player.open(width, height, Math.round(width * scale), Math.round(height * scale));
    }

    async function start(game) {
        show('loading', `Loading ${game.title}…`);
        try {
            const rom = await readFile(game.path);
            const save = await readFile(savePath(game));
            const info = await window.FlipfullRetro.load(rom, save);
            current = game;
            fit(info.width, info.height);
            play();
        } catch (e) {
            current = null;
            failed(e);
        }
    }

    function renderPlay() {
        el.barTitle.textContent = current ? current.title : 'GBA';
        keys = {};
        softkeys('', '', '');
    }

    function play() {
        held = 0;
        player.keys = 0;
        show('play');
        player.play();
    }

    function menuItems() {
        return [
            { name: 'Resume', run: play },
            { name: 'Save', run: () => writeSave().then(play, failed) },
            { name: 'FPS monitor', detail: stored('fps') === 'on' ? 'On' : 'Off', run: toggleMonitor },
            { name: 'Quit game', run: quit },
        ];
    }

    function renderMenu() {
        const menu = menuItems();
        el.barTitle.textContent = current ? current.title : 'GBA';
        el.menuItems.textContent = '';
        menu.forEach((m) => el.menuItems.appendChild(row(m.name, m.detail)));
        moveFocus('menu', el.menuItems, 0);
        keys = {
            center: () => menu[focus.menu].run(),
            back: play,
        };
        softkeys('', 'Select', '');
    }

    function pause() {
        player.pause();
        focus.menu = 0;
        show('menu');
    }

    async function quit() {
        show('loading', 'Saving…');
        try {
            await writeSave();
            await window.FlipfullRetro.unload();
        } catch (e) {}
        current = null;
        show('list');
    }

    function monitor(m) {
        el.fps.textContent = `${m.fps.toFixed(1)} fps`;
    }

    function useMonitor() {
        const on = stored('fps') === 'on';
        player.monitor = on ? monitor : null;
        el.fps.classList.toggle('show', on);
    }

    function toggleMonitor() {
        store('fps', stored('fps') === 'on' ? 'off' : 'on');
        useMonitor();
        renderMenu();
    }

    function gameKey(e, down) {
        if (e.key === 'Backspace' || e.key === 'GoBack') {
            if (down) {
                pause();
            }
            return true;
        }
        if (!(e.key in KEYS)) {
            return false;
        }
        const bit = 1 << KEYS[e.key];
        held = down ? held | bit : held & ~bit;
        player.keys = held;
        return true;
    }

    function onKeyDown(e) {
        if (view === 'play') {
            if (gameKey(e, true)) {
                e.preventDefault();
            }
            return;
        }
        let handled = true;
        switch (e.key) {
            case 'Enter':
                if (keys.center) keys.center();
                break;
            case 'ArrowUp':
            case 'ArrowDown': {
                const by = e.key === 'ArrowUp' ? -1 : 1;
                if (view === 'list') {
                    moveFocus('list', el.games, by);
                } else if (view === 'menu') {
                    moveFocus('menu', el.menuItems, by);
                }
                break;
            }
            case 'Backspace':
            case 'GoBack':
                if (keys.back) {
                    keys.back();
                } else {
                    handled = false;
                }
                break;
            default:
                handled = false;
        }
        if (handled) {
            e.preventDefault();
        }
    }

    function onKeyUp(e) {
        if (view === 'play' && gameKey(e, false)) {
            e.preventDefault();
        }
    }

    async function connect() {
        if (!window.FlipfullRetro) {
            el.offlineWhy.textContent = "Flipfull's retro.js didn't load from api-daemon.";
            show('offline');
            return;
        }
        show('loading');
        try {
            await window.FlipfullRetro.info();
            player.connect(await window.FlipfullRetro.stream());
            games = await scan();
            show('list');
        } catch (e) {
            failed(e);
        }
    }

    function begin() {
        player = new window.RetroPlayer(el.screen, {
            failed: (e) => {
                current = null;
                failed(e);
            },
        });
        useMonitor();
        connect();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && view === 'play') {
            pause();
        }
    });
    begin();
}());

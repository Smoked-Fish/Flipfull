'use strict';

(function () {
    const $ = (id) => document.getElementById(id);
    const el = {
        body: document.body, bar: $('bar'), barTitle: $('bar-title'), loadingText: $('loading-text'),
        offlineWhy: $('offline-why'), list: $('list'), games: $('games'), screen: $('screen'), fps: $('fps'),
        menuItems: $('menu-items'), keyItems: $('key-items'), keysHint: $('keys-hint'), toast: $('toast'),
        softkeys: $('softkeys'), left: $('sk-left'), center: $('sk-center'), right: $('sk-right'),
    };
    const FOLDER = 'games';
    const SYSTEMS = { gba: 'GBA', gbc: 'GBC', gb: 'GB' };
    const KEY_NAMES = {
        ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'OK', Call: 'Call',
        Backspace: 'Back', FavoriteContacts: 'Fav', Message: 'Msg',
    };
    const BUTTONS = [
        { id: 'up', name: 'Up', bit: 4 },
        { id: 'down', name: 'Down', bit: 5 },
        { id: 'left', name: 'Left', bit: 6 },
        { id: 'right', name: 'Right', bit: 7 },
        { id: 'a', name: 'A', bit: 8 },
        { id: 'b', name: 'B', bit: 0 },
        { id: 'l', name: 'L', bit: 10 },
        { id: 'r', name: 'R', bit: 11 },
        { id: 'start', name: 'Start', bit: 3 },
        { id: 'select', name: 'Select', bit: 2 },
    ];
    const PRESETS = [
        {
            id: 'standard',
            name: 'Standard',
            defaults: {
                up: ['ArrowUp', '2'], down: ['ArrowDown', '8'], left: ['ArrowLeft', '4'], right: ['ArrowRight', '6'],
                a: ['Enter', '5', '9'], b: ['7', '0', 'Backspace'], l: ['1'], r: ['3'], start: ['#'], select: ['*'],
            },
        },
        {
            id: 'keypad',
            name: 'Keypad',
            defaults: {
                up: ['2', 'ArrowUp'], down: ['8', 'ArrowDown'], left: ['4', 'ArrowLeft'], right: ['6', 'ArrowRight'],
                a: ['5', 'Enter'], b: ['3'], l: ['Backspace'], r: ['FavoriteContacts'], start: ['9'], select: ['7'],
            },
        },
        {
            id: 'custom',
            name: 'Custom',
            defaults: {
                up: ['ArrowUp', '2'], down: ['ArrowDown', '8'], left: ['ArrowLeft', '4'], right: ['ArrowRight', '6'],
                a: ['Enter', '5'], b: ['0', 'Backspace'], l: ['1'], r: ['3'], start: ['#'], select: ['*'],
            },
        },
    ];
    const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
        'ArrowRight', 'Enter', 'Call', 'Backspace', 'FavoriteContacts', 'Message'];

    const copy = (o) => JSON.parse(JSON.stringify(o));

    let view = 'loading';
    let keys = {};
    let toastTimer = null;
    let games = [];
    const focus = { list: 0, menu: 0, keys: 0 };
    let current = null;
    let player = null;
    const held = new Set();
    let presets = null;
    let keyBits = {};
    let waitingKey = false;

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

    function keyName(k) {
        return KEY_NAMES[k] || k;
    }

    function softkeys(left, center, right) {
        el.left.textContent = left || '';
        el.center.textContent = center || '';
        el.right.textContent = right || '';
    }

    function toast(text) {
        el.toast.textContent = text;
        el.toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.toast.classList.remove('show'), 3000);
    }

    function row(name, detail, extra) {
        const div = document.createElement('div');
        div.className = `row${extra ? ` ${extra}` : ''}`;
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
            case 'keys': return renderKeys();
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
        if (e && e.offline) {
            el.offlineWhy.textContent = e.message;
            show('offline');
        } else {
            toast((e && e.message) || String(e));
            show(current ? 'menu' : 'list');
        }
    }

    async function scan() {
        const found = [];
        const cursor = storage().enumerate(FOLDER);
        for await (const file of cursor.values()) {
            const name = file.name.replace(/^.*\//, '');
            const m = /^(.*)\.(gba|gbc|gb)$/i.exec(name);
            if (m) {
                found.push({ path: file.name, title: m[1], system: SYSTEMS[m[2].toLowerCase()] });
            }
        }
        return found.sort((a, b) => a.title.localeCompare(b.title));
    }

    function renderList() {
        el.barTitle.textContent = 'GBA';
        el.list.classList.toggle('empty', !games.length);
        el.games.textContent = '';
        games.forEach((g) => el.games.appendChild(row(g.title, g.system)));
        moveFocus('list', el.games, 0);
        keys = {
            center: () => games[focus.list] && start(games[focus.list]),
            back: () => window.close(),
        };
        softkeys('', games.length ? 'Play' : '', '');
    }

    function sibling(game, ext) {
        return game.path.replace(/\.[^./]*$/, `.${ext}`);
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
            await writeFile(sibling(current, 'sav'), await window.FlipfullRetro.save());
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
            const save = await readFile(sibling(game, 'sav'));
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
        held.clear();
        player.keys = 0;
        show('play');
        player.play();
    }

    async function pause() {
        held.clear();
        await player.pause();
        player.keys = 0;
    }

    function menuItems() {
        return [
            { name: 'Resume', run: play },
            { name: 'Save state', run: saveState },
            { name: 'Load state', run: loadState },
            { name: 'Reset', run: reset },
            { name: 'Keys', detail: preset().name, run: () => openKeys() },
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

    async function openMenu() {
        focus.menu = 0;
        show('menu');
        await pause();
    }

    async function saveState() {
        show('loading', 'Saving the state…');
        try {
            await writeSave();
            await writeFile(sibling(current, 'state'), await window.FlipfullRetro.saveState());
            play();
        } catch (e) {
            failed(e);
        }
    }

    async function loadState() {
        const state = await readFile(sibling(current, 'state'));
        if (!state.length) {
            toast('No state saved yet');
            return;
        }
        show('loading', 'Loading the state…');
        try {
            await window.FlipfullRetro.loadState(state);
            play();
        } catch (e) {
            failed(e);
        }
    }

    async function reset() {
        try {
            await window.FlipfullRetro.reset();
            play();
        } catch (e) {
            failed(e);
        }
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
        el.fps.textContent = `${m.fps.toFixed(1)} fps  shown ${Math.round(m.shown)}`;
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

    function loadPresets() {
        let saved = null;
        try {
            saved = JSON.parse(stored('presets'));
        } catch (e) {}
        presets = { active: PRESETS[0].id, maps: {} };
        PRESETS.forEach((p) => {
            presets.maps[p.id] = copy(p.defaults);
        });
        if (saved && saved.maps && PRESETS.some((p) => p.id === saved.active)) {
            presets.active = saved.active;
            PRESETS.forEach((p) => {
                if (saved.maps[p.id]) {
                    presets.maps[p.id] = saved.maps[p.id];
                }
            });
        }
        updateKeys();
    }

    function savePresets() {
        store('presets', JSON.stringify(presets));
        updateKeys();
    }

    function updateKeys() {
        keyBits = {};
        const map = presets.maps[presets.active];
        BUTTONS.forEach((b) => (map[b.id] || []).forEach((key) => {
            keyBits[key] = (keyBits[key] || 0) | (1 << b.bit);
        }));
    }

    function preset() {
        return PRESETS.find((p) => p.id === presets.active) || PRESETS[0];
    }

    function renderKeys() {
        const map = presets.maps[presets.active];
        el.barTitle.textContent = 'Keys';
        el.keysHint.textContent = waitingKey ? 'Press the key for the button, or Cancel.' : '';
        el.keyItems.textContent = '';
        el.keyItems.appendChild(row('Preset', preset().name));
        BUTTONS.forEach((b, i) => {
            const waiting = waitingKey && i + 1 === focus.keys;
            el.keyItems.appendChild(row(b.name, waiting ? 'press a key' : (map[b.id] || []).map(keyName).join('  ') || 'none',
                waiting ? 'waiting' : ''));
        });
        moveFocus('keys', el.keyItems, 0);
        if (waitingKey) {
            keys = {};
            softkeys('', '', 'Cancel');
            return;
        }
        keys = {
            left: () => {
                presets.maps[presets.active] = copy(preset().defaults);
                savePresets();
                renderKeys();
                toast(`${preset().name} has its own keys again.`);
            },
            center: () => {
                if (focus.keys === 0) {
                    const at = PRESETS.indexOf(preset());
                    presets.active = PRESETS[(at + 1) % PRESETS.length].id;
                    savePresets();
                } else {
                    waitingKey = true;
                }
                renderKeys();
            },
            back: () => show('menu'),
        };
        softkeys('Defaults', focus.keys === 0 ? 'Switch' : 'Change', '');
    }

    // the phone sends a MicrophoneToggle after other keys, ignore keys that aren't on the keypad
    function setKey(key) {
        if (key === 'SoftRight') {
            waitingKey = false;
        } else if (!KEYPAD.includes(key)) {
            return;
        } else {
            const map = presets.maps[presets.active];
            BUTTONS.forEach((b) => {
                map[b.id] = (map[b.id] || []).filter((x) => x !== key);
            });
            map[BUTTONS[focus.keys - 1].id] = [key];
            waitingKey = false;
            savePresets();
        }
        renderKeys();
    }

    function openKeys() {
        waitingKey = false;
        focus.keys = 0;
        show('keys');
    }

    function gameKey(e, down) {
        if (!(e.key in keyBits)) {
            if (e.key === 'Backspace' || e.key === 'GoBack') {
                if (down) {
                    openMenu();
                }
                return true;
            }
            return false;
        }
        if (down) {
            held.add(e.key);
        } else {
            held.delete(e.key);
        }
        let bits = 0;
        held.forEach((k) => {
            bits |= keyBits[k] || 0;
        });
        player.keys = bits;
        return true;
    }

    function onKeyDown(e) {
        if (view === 'play') {
            if (gameKey(e, true)) {
                e.preventDefault();
            }
            return;
        }
        if (view === 'keys' && waitingKey) {
            e.preventDefault();
            setKey(e.key);
            return;
        }
        let handled = true;
        switch (e.key) {
            case 'SoftLeft':
                if (keys.left) keys.left();
                break;
            case 'SoftRight':
                if (keys.right) keys.right();
                break;
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
                } else if (view === 'keys') {
                    moveFocus('keys', el.keyItems, by);
                    softkeys('Defaults', focus.keys === 0 ? 'Switch' : 'Change', '');
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
            el.offlineWhy.textContent = e.message;
            show('offline');
        }
    }

    function begin() {
        player = new window.RetroPlayer(el.screen, {
            failed: (e) => {
                if (e && e.offline) {
                    current = null;
                }
                failed(e);
            },
        });
        loadPresets();
        useMonitor();
        connect();
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && view === 'play') {
            openMenu();
        }
    });
    begin();
}());

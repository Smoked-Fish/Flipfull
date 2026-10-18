'use strict';

(function () {
    const $ = (id) => document.getElementById(id);
    const el = {
        body: document.body, bar: $('bar'), barTitle: $('bar-title'), barCount: $('bar-count'),
        loadingText: $('loading-text'), offlineWhy: $('offline-why'), list: $('list'), scanning: $('scanning'),
        games: $('games'), screen: $('screen'), fps: $('fps'), status: $('status'), menuItems: $('menu-items'), keyItems: $('key-items'), keysHint: $('keys-hint'), toast: $('toast'),
        softkeys: $('softkeys'), left: $('sk-left'), center: $('sk-center'), right: $('sk-right'),
    };
    const FOLDER = 'roms';
    const STATUS_HEIGHT = 22;
    const MENU_KEY = 'SoftLeft';
    const FAST_KEY = 'SoftRight';
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
    let statusTimer = null;
    let games = [];
    let scanned = false;
    let folder = '';
    const folderFocus = {};
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

    function status(text, lasts) {
        el.status.textContent = text || '';
        clearTimeout(statusTimer);
        if (text && !lasts) {
            statusTimer = setTimeout(() => {
                el.status.textContent = '';
            }, 3000);
        }
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
        el.barCount.textContent = '';
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
            const inside = file.name.slice(file.name.indexOf(`${FOLDER}/`) + FOLDER.length + 1);
            const name = inside.replace(/^.*\//, '');
            const m = /^(.*)\.(gba|gbc|gb)$/i.exec(name);
            if (m) {
                const folder = inside.slice(0, inside.length - name.length);
                found.push({ path: file.name, title: m[1], system: SYSTEMS[m[2].toLowerCase()], folder });
            }
        }
        return found;
    }

    function entries() {
        const folders = new Set();
        const here = [];
        games.forEach((g) => {
            if (!g.folder.toLowerCase().startsWith(folder.toLowerCase())) {
                return;
            }
            const rest = g.folder.slice(folder.length);
            if (rest) {
                folders.add(rest.slice(0, rest.indexOf('/')));
            } else {
                here.push(g);
            }
        });
        const named = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        return [...[...folders].sort(named).map((name) => ({ folder: `${folder}${name}/`, name })),
            ...here.sort((a, b) => named(a.title, b.title))];
    }

    function openFolder(path) {
        folderFocus[folder] = focus.list;
        folder = path;
        focus.list = folderFocus[folder] || 0;
        renderList();
    }

    function renderList() {
        const items = entries();
        el.barTitle.textContent = folder ? folder.slice(0, -1).replace(/^.*\//, '') : 'GBA';
        el.barCount.textContent = items.length ? String(items.length) : '';
        el.scanning.textContent = scanned ? '' : 'Looking for games…';
        el.list.classList.toggle('empty', scanned && !games.length);
        el.games.textContent = '';
        items.forEach((item) => {
            if (item.folder) {
                el.games.appendChild(row(item.name, '›', 'folder'));
            } else {
                el.games.appendChild(row(item.title, item.system));
            }
        });
        moveFocus('list', el.games, 0);
        keys = {
            center: () => {
                const item = items[focus.list];
                if (item && item.folder) {
                    openFolder(item.folder);
                } else if (item) {
                    start(item);
                }
            },
            right: () => rescan(),
            back: () => (folder ? openFolder(folder.replace(/[^/]*\/$/, '')) : window.close()),
        };
        listSoftkeys(items);
    }

    function listSoftkeys(items) {
        const item = items[focus.list];
        softkeys('', item ? (item.folder ? 'Open' : 'Play') : '', 'Rescan');
    }

    async function rescan() {
        scanned = false;
        show('list');
        try {
            games = await scan();
        } catch (e) {
            games = [];
            toast(`The games couldn't be listed: ${(e && e.message) || e}`);
        }
        scanned = true;
        const game = games.find((g) => g.path === stored('last'));
        if (game) {
            folder = game.folder;
            focus.list = Math.max(0, entries().indexOf(game));
        } else if (!entries().length) {
            folder = '';
        }
        if (view === 'list') {
            renderList();
        }
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
        const room = window.innerHeight - el.bar.offsetHeight - el.softkeys.offsetHeight - STATUS_HEIGHT;
        const scale = Math.max(1, Math.min(window.innerWidth / width, room / height));
        player.open(width, height, Math.round(width * scale), Math.round(height * scale));
    }

    async function start(game) {
        show('loading', `Loading ${game.title}…`);
        try {
            const rom = await readFile(game.path);
            const save = await readFile(sibling(game, 'sav'));
            const info = await window.FlipfullRetro.load(rom, save);
            store('last', game.path);
            current = game;
            fit(info.width, info.height);
            status('');
            play();
        } catch (e) {
            current = null;
            failed(e);
        }
    }

    function renderPlay() {
        el.barTitle.textContent = current ? current.title : 'GBA';
        keys = {};
        softkeys('Pause', '', 'Fast');
    }

    function play() {
        held.clear();
        player.keys = 0;
        show('play');
        player.play();
    }

    function resume() {
        if (current) {
            play();
        }
    }

    async function pause() {
        status('');
        held.clear();
        await player.pause();
        player.keys = 0;
    }

    function menuItems() {
        return [
            { name: 'Resume', run: resume },
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
            back: resume,
        };
        softkeys('', 'Select', '');
    }

    async function openMenu() {
        if (!current) {
            show('list');
            return;
        }
        const playing = view === 'play';
        if (playing) {
            focus.menu = 0;
        }
        show('menu');
        if (playing) {
            await pause();
        }
    }

    async function saveState() {
        show('loading', 'Saving the state…');
        try {
            await writeSave();
            await writeFile(sibling(current, 'state'), await window.FlipfullRetro.saveState());
            play();
            status('State saved');
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
            status('State loaded');
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
        status('');
        show('list');
    }

    function monitor(m) {
        const one = (n) => n.toFixed(1);
        el.fps.textContent = `${one(m.fps)} fps  shown ${Math.round(m.shown)}\ncore ${one(m.work)}  jitter ${one(m.jitter)}`;
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
        el.keysHint.textContent = waitingKey ? 'Press the key for the button, or Cancel.' :
            'The left soft key pauses; holding the right soft key fast forwards.';
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
        if (key === FAST_KEY) {
            waitingKey = false;
        } else if (!KEYPAD.includes(key)) {
            if (key === MENU_KEY) {
                toast('The left soft key pauses. Press another key.');
            }
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
        if (e.key === FAST_KEY) {
            player.fast = down;
            status(down ? 'Fast forward' : '', true);
            return true;
        }
        if (!(e.key in keyBits)) {
            if (down && e.key === MENU_KEY) {
                openMenu();
                return true;
            }
            return e.key === 'Backspace' || e.key === 'GoBack';
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
                    listSoftkeys(entries());
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
            rescan();
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
    window.addEventListener('blur', () => {
        if (view === 'play') {
            openMenu();
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && view === 'play') {
            openMenu();
        }
    });
    begin();
}());

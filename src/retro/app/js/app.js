'use strict';

(function () {
    const $ = (id) => document.getElementById(id);
    const el = {
        body: document.body, bar: $('bar'), barTitle: $('bar-title'), barCount: $('bar-count'),
        loadingText: $('loading-text'), offlineWhy: $('offline-why'), list: $('list'), scanning: $('scanning'),
        games: $('games'), screen: $('screen'), fps: $('fps'), status: $('status'), menuItems: $('menu-items'),
        slotItems: $('slot-items'), keyItems: $('key-items'), keysHint: $('keys-hint'), toast: $('toast'),
        softkeys: $('softkeys'), left: $('sk-left'), center: $('sk-center'), right: $('sk-right'),
    };
    const STATUS_HEIGHT = 22;
    const MENU_KEY = 'SoftLeft';
    const FAST_KEY = 'SoftRight';
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
    const KEY_CODES = {
        1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11, '*': 522, '#': 523,
        ArrowUp: 103, ArrowDown: 108, ArrowLeft: 105, ArrowRight: 106, Enter: 352, Call: 231,
        Backspace: 48, FavoriteContacts: 138, Message: 30,
    };

    const copy = (o) => JSON.parse(JSON.stringify(o));

    let view = 'loading';
    let keys = {};
    let toastTimer = null;
    let statusTimer = null;
    let games = [];
    let scanned = false;
    let folder = '';
    const folderFocus = {};
    const focus = { list: 0, menu: 0, slots: 0, keys: 0 };
    let current = null;
    let player = null;
    const held = new Set();
    let presets = null;
    let keyBits = {};
    let waitingKey = false;
    let slots = [];
    let saving = false;

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
            case 'slots': return renderSlots();
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
                el.games.appendChild(row(item.title, `${item.system}${item.sd ? ' SD' : ''}`));
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

    function rescan() {
        scanned = false;
        show('list');
        window.FlipfullRetro.games().then((found) => {
            games = found;
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
        }, (e) => {
            scanned = true;
            if (e && e.offline) {
                failed(e);
            } else {
                games = [];
                toast(`The games couldn't be listed: ${(e && e.message) || e}`);
                if (view === 'list') {
                    renderList();
                }
            }
        });
    }

    function fit(width, height) {
        const room = window.innerHeight - el.bar.offsetHeight - el.softkeys.offsetHeight - STATUS_HEIGHT;
        const scale = Math.max(1, Math.min(window.innerWidth / width, room / height));
        player.open(width, height, Math.round(width * scale), Math.round(height * scale));
    }

    async function start(game) {
        show('loading', `Loading ${game.title}…`);
        try {
            const info = await window.FlipfullRetro.load(game.path);
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
        player.play({ keymap: keymap(), ahead: ahead() });
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
            { name: 'Save state', detail: '›', run: () => openSlots(true) },
            { name: 'Load state', detail: '›', run: () => openSlots(false) },
            { name: 'Reset', run: reset },
            { name: 'Keys', detail: preset().name, run: () => openKeys() },
            { name: 'Run-ahead', detail: aheadName(), run: nextAhead },
            { name: 'FPS monitor', detail: stored('fps') === 'on' ? 'On' : 'Off', run: toggleMonitor },
            { name: 'Quit game', run: quit },
        ];
    }

    function aheadKey() {
        return current && current.system === 'GBA' ? 'ahead-gba' : 'ahead-gb';
    }

    function ahead() {
        return Number(stored(aheadKey())) || 0;
    }

    function aheadName() {
        const n = ahead();
        return n ? `${n} frame${n > 1 ? 's' : ''}` : 'Off';
    }

    function nextAhead() {
        store(aheadKey(), String((ahead() + 1) % 3));
        renderMenu();
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

    function stamp(secs) {
        const d = new Date(secs * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    async function openSlots(save) {
        saving = save;
        focus.slots = 0;
        slots = [];
        show('slots');
        try {
            slots = await window.FlipfullRetro.states();
            if (!save) {
                const newest = slots.reduce((b, s, i) => (s.time > (slots[b] || { time: 0 }).time ? i : b), 0);
                focus.slots = newest;
            }
        } catch (e) {
            toast(`The states couldn't be listed: ${(e && e.message) || e}`);
        }
        if (view === 'slots') {
            renderSlots();
        }
    }

    function renderSlots() {
        el.barTitle.textContent = saving ? 'Save state' : 'Load state';
        el.slotItems.textContent = '';
        slots.forEach((s) => el.slotItems.appendChild(row(`Slot ${s.slot + 1}`, s.time ? stamp(s.time) : 'empty')));
        moveFocus('slots', el.slotItems, 0);
        keys = {
            center: () => {
                const s = slots[focus.slots];
                if (s && saving) {
                    saveState(s.slot);
                } else if (s && s.time) {
                    loadState(s.slot);
                }
            },
            back: () => show('menu'),
        };
        softkeys('', slots.length ? (saving ? 'Save' : 'Load') : '', '');
    }

    async function saveState(slot) {
        show('loading', 'Saving the state…');
        try {
            await window.FlipfullRetro.saveState(slot);
            play();
            status(`State saved to slot ${slot + 1}`);
        } catch (e) {
            failed(e);
        }
    }

    async function loadState(slot) {
        show('loading', 'Loading the state…');
        try {
            await window.FlipfullRetro.loadState(slot);
            play();
            status(`State ${slot + 1} loaded`);
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
            await window.FlipfullRetro.unload();
        } catch (e) {}
        current = null;
        status('');
        show('list');
    }

    function monitor(m) {
        const one = (n) => n.toFixed(1);
        const lines = [
            `${one(m.fps)} fps  shown ${Math.round(m.shown)}  held ${Math.round(m.held)}  late ${Math.round(m.late)}`,
            `core ${one(m.work)}  lead ${m.lead === null ? '-' : one(m.lead)}`,
        ];
        el.fps.textContent = lines.join('\n');
        console.log(`[retro] ${lines.join(' | ')} | trip jitter ${one(m.jitter)} ms | refresh ${one(m.refresh)} (${m.hz.toFixed(3)} Hz), ` +
            `screen js ${Math.round(m.busy)} ms/s`);
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

    function keymap() {
        return Object.keys(keyBits).filter((key) => key in KEY_CODES).map((key) => [KEY_CODES[key], keyBits[key]]);
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
        } else if (!(key in KEY_CODES)) {
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
                } else if (view === 'slots') {
                    moveFocus('slots', el.slotItems, by);
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

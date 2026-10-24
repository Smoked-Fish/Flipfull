'use strict';

(function () {
    const $ = (id) => document.getElementById(id);
    const el = {
        body: document.body, bar: $('bar'), barTitle: $('bar-title'), barCount: $('bar-count'),
        loadingText: $('loading-text'), offlineWhy: $('offline-why'),
        list: $('list'), scanning: $('scanning'), games: $('games'),
        screen: $('screen'), fps: $('fps'), status: $('status'), menuItems: $('menu-items'), slotItems: $('slot-items'),
        settingItems: $('setting-items'), settingAbout: $('setting-about'), keyItems: $('key-items'),
        keysHint: $('keys-hint'), toast: $('toast'), dialog: $('dialog'), dialogText: $('dialog-text'),
        softkeys: $('softkeys'), left: $('sk-left'), center: $('sk-center'), right: $('sk-right'),
    };
    const SCROLL = 40;
    const STATUS_HEIGHT = 22;
    const MENU_KEY = 'SoftLeft';
    const FAST_KEY = 'SoftRight';
    const KEY_NAMES = {
        ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'OK', Call: 'Call',
        Backspace: 'Back', FavoriteContacts: 'Fav', Message: 'Msg',
    };

    const copy = (o) => JSON.parse(JSON.stringify(o));
    // localeCompare with options makes a collator every call, slow with a few hundred games
    const named = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

    let view = 'loading';
    let keys = {};
    let dialogKeys = null;
    let toastTimer = null;
    let statusTimer = null;
    let games = [];
    let scanned = false;
    let folder = '';
    let listItems = [];
    const folderFocus = {};
    const focus = { list: 0, menu: 0, slots: 0, settings: 0, keys: 0 };
    let current = null;
    let player = null;
    const held = new Set();
    let settings = null;
    let keyBits = {};
    let waitingKey = false;
    let settingsFrom = 'list';
    let keysFrom = 'settings';
    let wakeLock = null;
    let menu = [];
    let slots = [];
    let saving = false;

    function keyName(k) {
        return KEY_NAMES[k] || k;
    }

    function setting(key) {
        for (const section of settings ? settings.sections : []) {
            const item = section.items.find((i) => i.key === key);
            if (item) {
                return item;
            }
        }
        return null;
    }

    function choiceName(item) {
        const c = item.choices.find(([v]) => v === item.value);
        return c ? c[1] : item.value;
    }

    function updateKeys() {
        keyBits = {};
        const k = settings.keys;
        const map = k.maps[k.active];
        k.buttons.forEach((b) => (map[b.id] || []).forEach((key) => {
            keyBits[key] = (keyBits[key] || 0) | (1 << b.bit);
        }));
    }

    function took(s) {
        settings = s;
        updateKeys();
        player.monitor = setting('fps') && setting('fps').value === 'on' ? monitor : null;
        el.fps.classList.toggle('show', !!(setting('fps') && setting('fps').value === 'on'));
    }

    async function change(key, value) {
        try {
            took(await window.FlipfullRetro.set(key, value));
            return true;
        } catch (e) {
            toast(`Not changed: ${(e && e.message) || e}`, true);
            return false;
        }
    }

    function softkeys(left, center, right) {
        el.left.textContent = left || '';
        el.center.textContent = center || '';
        el.right.textContent = right || '';
    }

    function toast(text, isError) {
        el.toast.textContent = text;
        el.toast.classList.toggle('error', !!isError);
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

    function message(text, then) {
        el.dialogText.textContent = text;
        el.dialog.classList.add('show');
        el.dialog.scrollTop = 0;
        const close = () => {
            el.dialog.classList.remove('show');
            dialogKeys = null;
            if (then) {
                then();
            } else {
                render();
            }
        };
        dialogKeys = { center: close, back: close };
        softkeys('', 'OK', '');
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
        const rows = box.getElementsByClassName('row');
        if (!rows.length) {
            return;
        }
        focus[name] = step ? (focus[name] + step + rows.length) % rows.length : Math.min(focus[name], rows.length - 1);
        const r = rows[focus[name]];
        const old = box.querySelector('.row.focus');
        if (old !== r) {
            if (old) {
                old.classList.remove('focus');
            }
            r.classList.add('focus');
        }
        r.scrollIntoView({ block: 'nearest' });
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
            case 'settings': return renderSettings();
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
        listItems = items;
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
            left: () => openSettings('list'),
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
        softkeys('Settings', item ? (item.folder ? 'Open' : 'Play') : '', 'Rescan');
    }

    function rescan() {
        const last = (() => {
            try {
                return localStorage.getItem('last');
            } catch (e) {
                return null;
            }
        })();
        scanned = false;
        show('list');
        window.FlipfullRetro.games().then((found) => {
            games = found;
            scanned = true;
            const game = games.find((g) => g.path === last);
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
                toast(`The games couldn't be listed: ${(e && e.message) || e}`, true);
                if (view === 'list') {
                    renderList();
                }
            }
        });
    }

    function renderPlay() {
        el.barTitle.textContent = current ? current.title : 'GBA';
        keys = {};
        softkeys('Pause', '', 'Fast');
    }

    function failed(e) {
        if (e && e.offline) {
            el.offlineWhy.textContent = e.message;
            show('offline');
        } else {
            message((e && e.message) || String(e));
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
            const info = await window.FlipfullRetro.load(game.path);
            const [url, s] = await Promise.all([window.FlipfullRetro.stream(), window.FlipfullRetro.settings()]);
            player.connect(url);
            took(s);
            try {
                localStorage.setItem('last', game.path);
            } catch (e) {}
            current = game;
            fit(info.width, info.height);
            status('');
            play();
        } catch (e) {
            current = null;
            if (e && e.offline) {
                failed(e);
            } else {
                message(`${game.title} didn't start: ${(e && (e.message || e.name)) || e}`, () => show('list'));
            }
        }
    }

    function play() {
        held.clear();
        player.keys = 0;
        show('play');
        const latency = setting('latency');
        player.play({ latency: latency ? Number(latency.value) : 100 });
        if (!wakeLock) {
            try {
                const b2g = navigator.b2g;
                wakeLock = b2g && b2g.requestWakeLock ? b2g.requestWakeLock('screen') : null;
            } catch (e) {
                wakeLock = null;
            }
        }
    }

    function stopped() {
        if (wakeLock) {
            try {
                wakeLock.unlock();
            } catch (e) {}
            wakeLock = null;
        }
    }

    function resume() {
        if (current) {
            play();
        }
    }

    async function pause() {
        stopped();
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
            { name: 'Settings', detail: '›', run: () => openSettings('menu') },
            { name: 'Keys', detail: settings ? presetName() : '', run: () => openKeys('menu') },
            { name: 'Quit game', run: quit },
        ];
    }

    function renderMenu() {
        el.barTitle.textContent = current ? current.title : 'GBA';
        el.menuItems.textContent = '';
        menu.forEach((m) => el.menuItems.appendChild(row(m.name, m.detail || '')));
        moveFocus('menu', el.menuItems, 0);
        keys = {
            center: () => menu[focus.menu] && menu[focus.menu].run(),
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
        menu = menuItems();
        show('menu');
        if (playing) {
            await pause();
        }
    }

    function monitor(m) {
        const one = (n) => n.toFixed(1);
        const sound = m.sound < 0 ? 'no sound' : `snd ${Math.round(m.sound)}` + (m.dry ? ` gap ${m.dry}` : '');
        const lines = [
            `${one(m.fps)} fps  shown ${Math.round(m.shown)}  held ${Math.round(m.held)}  late ${Math.round(m.late)}`,
            `core ${one(m.work)}  lead ${m.lead === null ? '-' : one(m.lead)}  ${sound}`,
        ];
        el.fps.textContent = lines.join('\n');
        console.log(`[retro] ${lines.join(' | ')} | trip jitter ${one(m.jitter)} ms | refresh ${one(m.refresh)} (${m.hz.toFixed(3)} Hz), ` +
            `screen js ${Math.round(m.busy)} ms/s`);
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
            toast(`The states couldn't be listed: ${(e && e.message) || e}`, true);
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
            back: () => {
                menu = menuItems();
                show('menu');
            },
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
            message(`The state wasn't saved: ${(e && (e.message || e.name)) || e}`, openMenu);
        }
    }

    async function loadState(slot) {
        show('loading', 'Loading the state…');
        try {
            await window.FlipfullRetro.loadState(slot);
            play();
            status(`State ${slot + 1} loaded`);
        } catch (e) {
            message(`The state didn't load: ${(e && (e.message || e.name)) || e}`, openMenu);
        }
    }

    async function reset() {
        try {
            await window.FlipfullRetro.reset();
            play();
            status('');
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

    const KEYS_ROW = { key: 'keys', about: 'Which key is which button, in three presets.' };

    function settingRows() {
        const rows = [KEYS_ROW];
        settings.sections.forEach((section) => section.items.forEach((item) => rows.push(item)));
        return rows;
    }

    function renderSettings() {
        el.barTitle.textContent = 'Settings';
        el.settingItems.textContent = '';
        el.settingItems.appendChild(row('Keys', `${presetName()} ›`));
        settings.sections.forEach((section) => {
            const h = document.createElement('p');
            h.className = 'section';
            h.textContent = section.name;
            el.settingItems.appendChild(h);
            section.items.forEach((item) => el.settingItems.appendChild(row(item.name, choiceName(item))));
        });
        moveFocus('settings', el.settingItems, 0);
        keys = {
            center: () => step(1),
            back: () => (settingsFrom === 'menu' ? openMenu() : show('list')),
        };
        settingAbout();
    }

    function settingAbout() {
        const item = settingRows()[focus.settings];
        if (!item) {
            el.settingAbout.textContent = '';
            return;
        }
        const later = item.load && current ? ' From the next game you start.' : '';
        el.settingAbout.textContent = `${item.about}${later}`;
        softkeys('', item === KEYS_ROW ? 'Open' : 'Change', '');
    }

    async function step(by) {
        const item = settingRows()[focus.settings];
        if (item === KEYS_ROW) {
            openKeys('settings');
            return;
        }
        if (!item) {
            return;
        }
        const at = item.choices.findIndex(([v]) => v === item.value);
        const next = item.choices[(at + by + item.choices.length) % item.choices.length][0];
        if (await change(item.key, next) && view === 'settings') {
            renderSettings();
        }
    }

    async function openSettings(from) {
        settingsFrom = from;
        focus.settings = from === 'list' ? focus.settings : 0;
        try {
            took(await window.FlipfullRetro.settings());
        } catch (e) {
            return failed(e);
        }
        show('settings');
    }

    function preset() {
        const k = settings.keys;
        return k.presets.find((p) => p.id === k.active) || k.presets[0];
    }

    function presetName() {
        return preset().name;
    }

    function renderKeys() {
        const k = settings.keys;
        const map = k.maps[k.active];
        el.barTitle.textContent = 'Keys';
        el.keysHint.textContent = waitingKey ? 'Press the key for the button, or Cancel.' :
            'The left soft key pauses; holding the right soft key fast forwards.';
        el.keyItems.textContent = '';
        el.keyItems.appendChild(row('Preset', presetName()));
        k.buttons.forEach((b, i) => {
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
            left: async () => {
                const changed = copy(k);
                changed.maps[k.active] = copy(preset().defaults);
                if (await change('keys', { active: changed.active, maps: changed.maps })) {
                    renderKeys();
                    toast(`${presetName()} has its own keys again.`);
                }
            },
            center: async () => {
                if (focus.keys === 0) {
                    const at = k.presets.indexOf(preset());
                    await change('keys', { active: k.presets[(at + 1) % k.presets.length].id, maps: k.maps });
                } else {
                    waitingKey = true;
                }
                renderKeys();
            },
            back: () => (keysFrom === 'menu' ? openMenu() : show('settings')),
        };
        softkeys('Defaults', focus.keys === 0 ? 'Switch' : 'Change', '');
    }

    // the phone sends a MicrophoneToggle after other keys, ignore keys that aren't on the keypad
    async function setKey(key) {
        const k = settings.keys;
        if (key === FAST_KEY) {
            waitingKey = false;
        } else if (!(key in k.codes)) {
            if (key === MENU_KEY) {
                toast('The left soft key pauses. Press another key.', true);
            }
            return;
        } else {
            const maps = copy(k.maps);
            const map = maps[k.active];
            const button = k.buttons[focus.keys - 1];
            k.buttons.forEach((b) => {
                map[b.id] = (map[b.id] || []).filter((x) => x !== key);
            });
            map[button.id] = [key];
            waitingKey = false;
            await change('keys', { active: k.active, maps });
        }
        renderKeys();
    }

    async function openKeys(from) {
        keysFrom = from;
        waitingKey = false;
        try {
            took(await window.FlipfullRetro.settings());
        } catch (e) {
            return failed(e);
        }
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
        if (view === 'play' && !dialogKeys) {
            if (gameKey(e, true)) {
                e.preventDefault();
            }
            return;
        }
        if (view === 'keys' && waitingKey && !dialogKeys) {
            e.preventDefault();
            setKey(e.key);
            return;
        }
        const k = dialogKeys || keys;
        let handled = true;
        switch (e.key) {
            case 'SoftLeft':
                if (k.left) k.left();
                break;
            case 'SoftRight':
                if (k.right) k.right();
                break;
            case 'Enter':
                if (k.center) k.center();
                break;
            case 'ArrowUp':
            case 'ArrowDown': {
                const by = e.key === 'ArrowUp' ? -1 : 1;
                if (dialogKeys) {
                    el.dialog.scrollTop += by * SCROLL;
                } else if (view === 'list') {
                    moveFocus('list', el.games, by);
                    listSoftkeys(listItems);
                } else if (view === 'menu') {
                    moveFocus('menu', el.menuItems, by);
                } else if (view === 'slots') {
                    moveFocus('slots', el.slotItems, by);
                } else if (view === 'settings') {
                    moveFocus('settings', el.settingItems, by);
                    settingAbout();
                } else if (view === 'keys') {
                    moveFocus('keys', el.keyItems, by);
                    softkeys('Defaults', focus.keys === 0 ? 'Switch' : 'Change', '');
                }
                break;
            }
            case 'ArrowLeft':
            case 'ArrowRight':
                if (view === 'settings' && !dialogKeys && settingRows()[focus.settings] !== KEYS_ROW) {
                    step(e.key === 'ArrowLeft' ? -1 : 1);
                } else {
                    handled = false;
                }
                break;
            case 'Backspace':
            case 'GoBack':
                if (k.back) {
                    k.back();
                } else {
                    handled = view === 'loading';
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
        if (view === 'play' && !dialogKeys && gameKey(e, false)) {
            e.preventDefault();
        }
    }

    function begin() {
        player = new window.RetroPlayer(el.screen, {
            failed: (e) => {
                stopped();
                if (e && e.offline) {
                    current = null;
                    failed(e);
                } else {
                    message(`The game stopped: ${(e && e.message) || e}`, openMenu);
                }
            },
        });
        connect();
    }

    async function migrate(s) {
        const old = (k) => {
            try {
                return localStorage.getItem(k);
            } catch (e) {
                return null;
            }
        };
        const changes = [];
        try {
            const presets = JSON.parse(old('presets'));
            if (presets) {
                changes.push(['keys', presets]);
            }
        } catch (e) {}
        ['gba', 'gb'].forEach((f) => {
            const ahead = old(`ahead-${f}`);
            if (ahead !== null) {
                changes.push([`ahead_${f}`, ahead]);
            }
        });
        if (old('fps') !== null) {
            changes.push(['fps', old('fps')]);
        }
        for (const [key, value] of changes) {
            try {
                s = await window.FlipfullRetro.set(key, value);
            } catch (e) {}
        }
        ['presets', 'keys', 'ahead-gba', 'ahead-gb', 'fps'].forEach((k) => {
            try {
                localStorage.removeItem(k);
            } catch (e) {}
        });
        return s;
    }

    function connect() {
        if (!window.FlipfullRetro) {
            el.offlineWhy.textContent = "Flipfull's retro.js didn't load from api-daemon.";
            show('offline');
            return;
        }
        show('loading');
        const r = window.FlipfullRetro;
        Promise.all([r.stream(), r.settings().then(migrate)]).then(([url, s]) => {
            took(s);
            player.connect(url);
            rescan();
        }, (e) => {
            el.offlineWhy.textContent = e.message;
            show('offline');
        });
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

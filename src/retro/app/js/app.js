'use strict';

(function () {
    const $ = (id) => document.getElementById(id);
    const el = {
        body: document.body, bar: $('bar'), barTitle: $('bar-title'), barCount: $('bar-count'),
        loadingText: $('loading-text'), offlineWhy: $('offline-why'),
        list: $('list'), scanning: $('scanning'), games: $('games'),
        screen: $('screen'), fps: $('fps'), status: $('status'), menuItems: $('menu-items'), slotItems: $('slot-items'),
        settingItems: $('setting-items'), keyItems: $('key-items'), keysHint: $('keys-hint'), toast: $('toast'),
        dialog: $('dialog'), dialogTitle: $('dialog-title'), dialogText: $('dialog-text'),
        softkeys: $('softkeys'), left: $('sk-left'), center: $('sk-center'), right: $('sk-right'),
    };
    const SCROLL = 40;
    const STATUS_HEIGHT = 22;
    const KEY_NAMES = {
        ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'OK', Call: 'Call',
        Backspace: 'Back', FavoriteContacts: 'Fav', Message: 'Msg', SoftLeft: 'Left soft', SoftRight: 'Right soft',
    };

    const named = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

    let view = 'loading';
    let keys = {};
    let dialogKeys = null;
    let toastTimer = null;
    let statusTimer = null;
    let games = [];
    let scanned = false;
    let folder = '';
    const folderFocus = {};
    const focus = { list: 0, menu: 0, slots: 0, settings: 0, keys: 0 };
    let current = null;
    let player = null;
    const held = new Set();
    let settings = null;
    let keyBits = {};
    let pauseKeys = [];
    let fastKeys = [];
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

    function took(s) {
        settings = s;
        keyBits = s.play.keys;
        pauseKeys = s.play.pause;
        fastKeys = s.play.fast;
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

    function message(text, then, title) {
        el.dialogTitle.textContent = title || '';
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
        dialogKeys = {
            center: close,
            back: close,
            move: (by) => {
                el.dialog.scrollTop += by * SCROLL;
            },
        };
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
                keys = { back() {} };
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
            move: (by) => {
                moveFocus('list', el.games, by);
                listSoftkeys(items);
            },
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
        keys = { any: gameKey };
        softkeys(buttonOn('SoftLeft'), '', buttonOn('SoftRight'));
    }

    function buttonOn(key) {
        const k = settings.keys;
        const map = k.maps[k.active];
        const b = k.buttons.find((button) => (map[button.id] || []).includes(key));
        return b ? b.name : '';
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
        const fits = Math.min(window.innerWidth / width, room / height);
        const cut = setting('sgb_borders') && setting('sgb_borders').value === 'cut';
        const scale = cut ? Math.max(1, fits) : fits;
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
        player.play({ latency: settings.play.latency });
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
            move: (by) => moveFocus('menu', el.menuItems, by),
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
            move: (by) => moveFocus('slots', el.slotItems, by),
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

    const KEYS_ROW = { key: 'keys', name: 'Keys', about: 'Which key is which button, pause and fast forward, in three presets.' };

    function settingRows() {
        const rows = [KEYS_ROW];
        settings.sections.forEach((section) => section.items.forEach((item) => rows.push(item)));
        return rows;
    }

    function renderSettings() {
        el.barTitle.textContent = 'Settings';
        el.settingItems.textContent = '';
        el.settingItems.appendChild(row(KEYS_ROW.name, `${presetName()} ›`));
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
            right: settingInfo,
            back: () => (settingsFrom === 'menu' ? openMenu() : show('list')),
            move: (by) => {
                moveFocus('settings', el.settingItems, by);
                settingSoftkeys();
            },
            side: (by) => settingRows()[focus.settings] !== KEYS_ROW && step(by),
        };
        settingSoftkeys();
    }

    function settingSoftkeys() {
        const item = settingRows()[focus.settings];
        softkeys('', item ? (item === KEYS_ROW ? 'Open' : 'Change') : '', item ? 'Info' : '');
    }

    function settingInfo() {
        const item = settingRows()[focus.settings];
        if (item) {
            const later = item.load && current ? '\n\nFrom the next game you start.' : '';
            message(`${item.about}${later}`, null, item.name);
        }
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

    function keysSoftkeys() {
        softkeys('Defaults', focus.keys === 0 ? 'Switch' : 'Change', '');
    }

    function renderKeys() {
        const k = settings.keys;
        const map = k.maps[k.active];
        el.barTitle.textContent = 'Keys';
        el.keyItems.textContent = '';
        el.keyItems.appendChild(row('Preset', presetName()));
        k.buttons.forEach((b, i) => {
            const waiting = waitingKey && i + 1 === focus.keys;
            el.keyItems.appendChild(row(b.name, waiting ? 'press a key' : (map[b.id] || []).map(keyName).join('  ') || 'none',
                waiting ? 'waiting' : ''));
        });
        moveFocus('keys', el.keyItems, 0);
        if (waitingKey) {
            keys = {
                any: (e, down) => {
                    if (down) {
                        setKey(e.key);
                    }
                    return down;
                },
            };
            softkeys('', '', '');
            return;
        }
        keys = {
            left: async () => {
                if (await change('keys.defaults', null)) {
                    renderKeys();
                    toast(`${presetName()} has its own keys again.`);
                }
            },
            center: async () => {
                if (focus.keys === 0) {
                    const at = k.presets.indexOf(preset());
                    await change('keys.preset', k.presets[(at + 1) % k.presets.length].id);
                } else {
                    waitingKey = true;
                }
                renderKeys();
            },
            back: () => (keysFrom === 'menu' ? openMenu() : show('settings')),
            move: (by) => {
                moveFocus('keys', el.keyItems, by);
                keysSoftkeys();
            },
        };
        keysSoftkeys();
    }

    async function setKey(key) {
        const k = settings.keys;
        if (!(key in k.codes)) {
            return;
        }
        waitingKey = false;
        const button = k.buttons[focus.keys - 1].id;
        if (!(k.maps[k.active][button] || []).includes(key)) {
            await change('keys.button', { button, key });
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
        if (fastKeys.includes(e.key)) {
            player.fast = down;
            const labelled = fastKeys.some((k) => k === 'SoftLeft' || k === 'SoftRight');
            el.center.textContent = down && !labelled ? 'Fast forward' : '';
            return true;
        }
        if (pauseKeys.includes(e.key)) {
            if (down) {
                openMenu();
            }
            return true;
        }
        if (!(e.key in keyBits)) {
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
        const k = dialogKeys || keys;
        if (k.any) {
            if (k.any(e, true)) {
                e.preventDefault();
            }
            return;
        }
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
            case 'ArrowDown':
                if (k.move) k.move(e.key === 'ArrowUp' ? -1 : 1);
                break;
            case 'ArrowLeft':
            case 'ArrowRight':
                handled = !!k.side && k.side(e.key === 'ArrowLeft' ? -1 : 1) !== false;
                break;
            case 'Backspace':
            case 'GoBack':
                if (k.back) {
                    k.back();
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
        const k = dialogKeys || keys;
        if (k.any && k.any(e, false)) {
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

    function connect() {
        if (!window.FlipfullRetro) {
            el.offlineWhy.textContent = "Flipfull's retro.js didn't load from api-daemon.";
            show('offline');
            return;
        }
        show('loading');
        const r = window.FlipfullRetro;
        Promise.all([r.stream(), r.settings()]).then(([url, s]) => {
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

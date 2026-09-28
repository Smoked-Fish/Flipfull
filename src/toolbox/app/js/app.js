'use strict';

(function () {
  const API = 'http://127.0.0.1:8323/cgi-bin/api';
  const M = window.FlipfullModel;
  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body, titleText: $('title-text'), busy: $('busy'),
    offlineWhy: $('offline-why'), notice: $('notice'), features: $('features'),
    sectionName: $('section-name'), sectionCount: $('section-count'),
    menuItems: $('menu-items'), removableItems: $('removable-items'),
    googleClient: $('google-client'), logText: $('log-text'),
    aboutVersion: $('about-version'), aboutHook: $('about-hook'),
    updateText: $('update-text'), updateNotes: $('update-notes'), updateLog: $('update-log'),
    toast: $('toast'), dialog: $('dialog'), dialogText: $('dialog-text'),
    left: $('sk-left'), center: $('sk-center'), right: $('sk-right'),
  };
  const TITLES = {
    list: 'Flipfull', menu: 'Options', removable: 'Uninstallable apps',
    google: 'Google sign-in client', log: 'Boot log', about: 'About Flipfull',
    update: 'Check for updates',
  };
  const SCROLL = 40;
  const POLL = 2000;

  let registry = [];
  let state = { features: {} };
  let view = 'loading';
  let busy = false;
  let keys = {};
  let dialogKeys = null;
  let toastTimer = null;
  const focus = { list: 0, menu: 0, removable: 0 };
  let groups = [];
  let section = 0;
  const sectionFocus = {};
  let listItems = [];
  let apps = [];
  let appsChanged = false;
  let release = null;
  let update = null;
  let pollTimer = null;

  function run(...words) {
    return fetch(API, { method: 'POST', body: words.join(' '), cache: 'no-store' })
      .then((r) => r.text().then((text) => {
        if (!r.ok) {
          throw new Error(text.trim() || `HTTP ${r.status}`);
        }
        return text;
      }));
  }

  function refresh() {
    return run('state').then((text) => {
      state = M.parseState(text);
    });
  }

  function work(label, fn) {
    if (busy) {
      return Promise.resolve();
    }
    busy = true;
    el.busy.textContent = label;
    return fn().catch((e) => {
      if (e instanceof TypeError) {
        el.offlineWhy.textContent = e.message;
        show('offline');
      } else {
        message(e.message);
      }
    }).finally(() => {
      busy = false;
      el.busy.textContent = '';
    });
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
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 4000);
  }

  function closeDialog() {
    el.dialog.classList.remove('show');
    dialogKeys = null;
    updateKeys();
  }

  function ask(text, ok, onOk) {
    el.dialogText.textContent = text;
    el.dialog.classList.add('show');
    el.dialog.scrollTop = 0;
    dialogKeys = {
      left: closeDialog,
      right: () => {
        closeDialog();
        onOk();
      },
      back: closeDialog,
    };
    softkeys('Cancel', '', ok);
  }

  function message(text) {
    el.dialogText.textContent = text;
    el.dialog.classList.add('show');
    dialogKeys = { center: closeDialog, back: closeDialog };
    softkeys('', 'OK', '');
  }

  function row(name, on, status, about, extraClass) {
    const div = document.createElement('div');
    div.className = `row${on ? ' on' : ''}${extraClass ? ` ${extraClass}` : ''}`;
    const head = document.createElement('div');
    head.className = 'row-head';
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name;
    head.appendChild(label);
    if (on !== null) {
      const sw = document.createElement('span');
      sw.className = 'switch';
      head.appendChild(sw);
    }
    div.appendChild(head);
    const st = document.createElement('p');
    st.className = 'status';
    st.textContent = status || '';
    div.appendChild(st);
    if (about) {
      const ab = document.createElement('p');
      ab.className = 'about';
      ab.textContent = about;
      div.appendChild(ab);
    }
    return div;
  }

  function moveFocus(name, step) {
    const box = $(name);
    const rows = Array.from(box.querySelectorAll('.row'));
    if (rows.length) {
      focus[name] = step ? (focus[name] + step + rows.length) % rows.length : Math.min(focus[name], rows.length - 1);
      rows.forEach((r, i) => r.classList.toggle('focus', i === focus[name]));
      rows[focus[name]].scrollIntoView({ block: 'nearest' });
      if (focus[name] === 0) {
        box.scrollTop = 0;
      }
    }
    updateKeys();
  }

  function switchSection(step) {
    if (groups.length < 2) {
      return;
    }
    sectionFocus[groups[section].name] = focus.list;
    section = (section + step + groups.length) % groups.length;
    focus.list = sectionFocus[groups[section].name] || 0;
    renderList();
  }

  function show(name) {
    view = name;
    el.body.dataset.view = name;
    el.titleText.textContent = TITLES[name] || 'Flipfull';
    render();
  }

  function render() {
    switch (view) {
      case 'list': return renderList();
      case 'menu': return renderMenu();
      case 'removable': return renderRemovable();
      case 'google': return renderGoogle();
      case 'about': return renderAbout();
      case 'update': return renderUpdate();
      default: return updateKeys();
    }
  }

  function renderList() {
    const notes = [];
    if (state.hook === false) {
      notes.push("The boot hook is missing, so nothing here starts when the phone does.");
    }
    if (state.reboot) {
      notes.push('Some changes wait for a reboot.');
    }
    el.notice.textContent = notes.join(' ');
    groups = M.sections(registry, state);
    section = Math.min(section, Math.max(0, groups.length - 1));
    const group = groups[section];
    el.sectionName.textContent = group ? group.name : '';
    el.sectionCount.textContent = groups.length > 1 ? `${section + 1}/${groups.length}` : '';
    listItems = group ? group.items : [];
    el.features.textContent = '';
    listItems.forEach((item) => {
      const r = row(item.title, item.on, M.statusText(item), item.about, item.usable === 'no' ? 'unusable' : '');
      r.querySelector('.status').classList.toggle('waiting', item.pending);
      el.features.appendChild(r);
    });
    moveFocus('list', 0);
  }

  const MENU = [
    ['Uninstallable apps', () => showRemovable()],
    ['Google sign-in client', () => show('google')],
    ['Reboot', () => reboot()],
    ["Restart the phone's UI", () => restartUi()],
    ['Boot log', () => showLog()],
    ['Check for updates', () => checkUpdates()],
    ['About Flipfull', () => show('about')],
    ['Remove Flipfull', () => removeFlipfull()],
  ];

  function renderMenu() {
    el.menuItems.textContent = '';
    MENU.forEach(([name]) => el.menuItems.appendChild(row(name, null)));
    moveFocus('menu', 0);
  }

  function renderRemovable() {
    el.removableItems.textContent = '';
    apps.forEach((app) => {
      let status = app.core ? `The phone needs it: ${app.core}` : '';
      if (app.chosen !== app.removable) {
        status = `${status ? `${status}. ` : ''}Changes at the next reboot`;
      }
      el.removableItems.appendChild(row(app.title, app.chosen, status, app.title !== app.name ? app.name : ''));
    });
    moveFocus('removable', 0);
  }

  function renderGoogle() {
    const f = state.features['google-accounts'];
    el.googleClient.textContent = (state.googleClient ? `Your client: ${state.googleClient}.` : 'No client yet.') +
      (f ? ` Google accounts is ${f.on ? 'on' : 'off'}${f.pending ? ' after a reboot' : ''}.` : '');
    updateKeys();
  }

  function renderAbout() {
    el.aboutVersion.textContent = state.version || '';
    el.aboutHook.textContent = state.hook ? 'Starts with the phone: yes.' :
      "Starts with the phone: no. The boot hook (src/boot-hook in the Flipfull repo) isn't on this phone.";
    updateKeys();
  }

  function mb(bytes) {
    return `${(bytes / 1e6).toFixed(1)} MB`;
  }

  function canUpdate() {
    return update.status !== 'running' &&
      [-1, null].includes(M.compareVersions(M.installedVersion(state.version), release.tag));
  }

  function renderUpdate() {
    const installed = M.installedVersion(state.version) || 'unknown';
    let status;
    if (update.status === 'running') {
      status = `${update.detail}…`;
      if (update.detail === 'Downloading' && update.bytes) {
        status += ` ${mb(update.bytes)} of ${mb(release.asset.size)}`;
      }
    } else {
      status = {
        '-1': 'An update is ready.',
        0: 'Flipfull is up to date.',
        1: 'This phone has a newer version than the latest release.',
        null: "This is a development build. It can't be compared with the release.",
      }[M.compareVersions(installed, release.tag)];
      if (update.status === 'failed') {
        status += `\nThe last update failed: ${update.detail}`;
      }
    }
    el.updateText.textContent = `Installed: ${installed}\nLatest: ${release.tag} (${mb(release.asset.size)})\n\n${status}`;
    el.updateNotes.textContent = release.notes.slice(0, 800);
    el.updateLog.textContent = update.status === 'none' || update.status === 'done' ? '' : update.log.join('\n');
    updateKeys();
  }

  function updateKeys() {
    if (dialogKeys) {
      return;
    }
    const back = () => show('list');
    switch (view) {
      case 'list': {
        const item = listItems[focus.list];
        const pending = state.reboot || state.removablePending;
        keys = {
          left: () => show('menu'),
          center: item && (() => toggle(item)),
          right: pending && reboot,
          back: () => window.close(),
        };
        softkeys('Options', item ? (item.on ? 'Turn off' : 'Turn on') : '', pending ? 'Reboot' : '');
        break;
      }
      case 'menu':
        keys = { left: back, center: () => MENU[focus.menu][1](), back };
        softkeys('Back', 'Select', '');
        break;
      case 'removable': {
        const app = apps[focus.removable];
        const leave = () => (appsChanged ? ask('Leave without saving?', 'Leave', () => show('menu')) : show('menu'));
        keys = { left: leave, center: app && (() => toggleApp(app)), right: saveApps, back: leave };
        softkeys('Back', app ? (app.chosen ? 'Turn off' : 'Turn on') : '', 'Save');
        break;
      }
      case 'google':
        keys = { left: () => show('menu'), center: importClient, right: state.googleClient && removeClient,
          back: () => show('menu') };
        softkeys('Back', 'Import', state.googleClient ? 'Remove' : '');
        break;
      case 'log':
      case 'about':
        keys = { left: () => show('menu'), back: () => show('menu') };
        softkeys('Back', '', '');
        break;
      case 'update':
        keys = { left: () => show('menu'), right: canUpdate() && installUpdate, back: () => show('menu') };
        softkeys('Back', '', canUpdate() ? 'Install' : '');
        break;
      case 'offline':
        keys = { center: start, back: () => window.close() };
        softkeys('', 'Retry', '');
        break;
      default:
        keys = { back: () => window.close() };
        softkeys('', '', '');
    }
  }

  function itemOf(id) {
    return registry.find((f) => f.id === id) || { id, title: id };
  }

  function toggle(item) {
    const on = !item.on;
    if (on && item.usable === 'no') {
      toast(`${item.title} can't work on this phone: ${item.reason}`, true);
      return;
    }
    const go = () => setFeature(item, on);
    if (!on && item['ask-off']) {
      ask(item['ask-off'], 'Turn off', go);
    } else {
      go();
    }
  }

  function setFeature(item, on) {
    return work(on ? 'Turning on…' : 'Turning off…', () => run('set', item.id, on ? 'on' : 'off').then((out) => {
      const result = M.parseSet(out);
      return refresh().then(() => {
        render();
        if (result.errors.length) {
          message(result.errors.join('\n'));
          return;
        }
        let text = `${item.title} is ${on ? 'on' : 'off'}.`;
        if (result.also.length) {
          text += ` So is ${result.also.map((a) => itemOf(a.id).title).join(', ')}.`;
        }
        const now = state.features[item.id];
        if (now && now.pending) {
          text += ' Reboot to finish.';
        }
        toast(text);
      });
    }, (e) => refresh().then(render, () => {}).then(() => {
      throw e;
    })));
  }

  function reboot() {
    ask('Reboot the phone now?', 'Reboot', () => work('Rebooting…', () => run('reboot')));
  }

  function restartUi() {
    ask("The screen goes black for about 15 seconds while the phone's UI starts again, and this app closes. " +
      'Features that wait for a reboot still do. Restart it now?', 'Restart', () => work('Restarting…', () => run('restart')));
  }

  function showLog() {
    work('Loading…', () => run('log', '150').then((text) => {
      el.logText.textContent = text;
      show('log');
      $('log').scrollTop = $('log').scrollHeight;
    }));
  }

  function latestRelease() {
    const repo = state.releaseRepo;
    return fetch(`https://api.github.com/repos/${repo}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
      .catch(() => {
        throw new Error("Couldn't reach GitHub. Is the phone online?");
      })
      .then((r) => {
        if (r.status === 404) {
          throw new Error(`github.com/${repo} has no releases.`);
        }
        if (!r.ok) {
          throw new Error(`GitHub answered ${r.status}. Try again later.`);
        }
        return r.json();
      })
      .then(M.pickUpdate);
  }

  function checkUpdates() {
    work('Checking…', () => Promise.all([latestRelease(), run('update', 'status')]).then(([rel, text]) => {
      release = rel;
      update = M.parseUpdate(text);
      show('update');
      if (update.status === 'running') {
        pollUpdate();
      }
    }));
  }

  function installUpdate() {
    ask(`Download ${mb(release.asset.size)} and install Flipfull ${release.tag}? If the update replaces this ` +
      "app, it closes; open it again when it's done. Some changes wait for a reboot.", 'Install', () =>
      work('Starting…', () => run('update', 'start', release.tag, release.asset.name, release.asset.sha256).then(() => {
        update = { status: 'running', detail: 'Downloading', bytes: 0, log: [] };
        renderUpdate();
        pollUpdate();
      })));
  }

  function pollUpdate() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      if (view !== 'update') {
        return;
      }
      run('update', 'status').then((text) => {
        const now = M.parseUpdate(text);
        if (now.status === 'none') {
          pollUpdate();
          return null;
        }
        update = now;
        if (update.status === 'running') {
          renderUpdate();
          pollUpdate();
          return null;
        }
        return refresh().then(() => {
          renderUpdate();
          if (update.status === 'done') {
            toast(`Flipfull is updated to ${M.installedVersion(state.version)}.${state.reboot ? ' Reboot to finish.' : ''}`);
          } else {
            message(`The update failed: ${update.detail}`);
          }
        });
      }, pollUpdate);
    }, POLL);
  }

  function removeFlipfull() {
    ask('Remove Flipfull? Every feature goes, the apps it added are uninstalled, its settings are deleted, ' +
      'and the phone restarts the way it came.', 'Remove', () => work('Removing…', () =>
      run('uninstall', '--reboot').then(() => toast('Flipfull is removed. The phone restarts in a moment.'))));
  }

  function showRemovable() {
    work('Loading…', () => run('removable').then((text) => {
      apps = M.parseRemovable(text);
      appsChanged = false;
      focus.removable = 0;
      show('removable');
    }));
  }

  function toggleApp(app) {
    const flip = () => {
      app.chosen = !app.chosen;
      appsChanged = true;
      renderRemovable();
    };
    if (!app.chosen && app.core) {
      ask(`The phone needs ${app.title} (${app.core}). Without it the phone may not work. ` +
        'Let it be uninstalled anyway?', 'Yes', flip);
    } else {
      flip();
    }
  }

  function saveApps() {
    const names = apps.filter((a) => a.chosen).map((a) => a.name);
    work('Saving…', () => run('removable', 'set', ...names).then(refresh).then(() => {
      appsChanged = false;
      show('menu');
      toast(state.removablePending ? 'Saved. The next reboot applies it.' : 'Saved.');
    }));
  }

  function importClient() {
    work('Importing…', () => run('google-client', 'import').then((text) => refresh().then(() => {
      render();
      const f = state.features['google-accounts'];
      if (f && !f.on) {
        ask(`${text.trim()}.\n\nTurn on Google accounts too?`, 'Turn on', () => setFeature(itemOf('google-accounts'), true));
      } else {
        toast(text.trim());
      }
    })));
  }

  function removeClient() {
    ask('Remove your Google sign-in client? Accounts added with it stop syncing.', 'Remove', () =>
      work('Removing…', () => run('google-client', 'remove').then(refresh).then(render)));
  }

  function onKey(e) {
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
      case 'ArrowLeft':
      case 'ArrowRight':
        if (view === 'list' && !dialogKeys) {
          switchSection(e.key === 'ArrowLeft' ? -1 : 1);
        } else {
          handled = false;
        }
        break;
      case 'ArrowUp':
      case 'ArrowDown': {
        const step = e.key === 'ArrowUp' ? -1 : 1;
        if (dialogKeys) {
          el.dialog.scrollTop += step * SCROLL;
        } else if (view in focus) {
          moveFocus(view, step);
        } else if ($(view)) {
          $(view).scrollTop += step * SCROLL;
        }
        break;
      }
      case 'Backspace':
      case 'GoBack':
        if (k.back) k.back();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
    }
  }

  function start() {
    show('loading');
    Promise.all([run('features'), run('state')]).then(([ini, text]) => {
      registry = M.parseIni(ini);
      state = M.parseState(text);
      show('list');
    }, (e) => {
      el.offlineWhy.textContent = e.message;
      show('offline');
    });
  }

  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && view === 'list' && !busy && !dialogKeys) {
      refresh().then(renderList, () => {});
    }
  });
  start();
}());

'use strict';

(function () {
  const M = window.CameraModel;
  const $ = (id) => document.getElementById(id);
  const el = {
    body: document.body, preview: $('preview'), picture: $('picture'), mode: $('mode'), icons: $('icons'),
    zoom: $('zoom'), status: $('status'), blink: $('blink'), rows: $('rows'),
    review: $('review'), reviewImage: $('review-image'), reviewVideo: $('review-video'), reviewInfo: $('review-info'),
    keyList: $('key-list'),
    toast: $('toast'), dialog: $('dialog'), dialogText: $('dialog-text'),
    left: $('sk-left'), center: $('sk-center'), right: $('sk-right'),
  };
  const SETTINGS = 'camera.settings';
  const CONFIG = 'camera.config';
  const SPOT = [{ top: -100, left: -100, bottom: 100, right: 100, weight: 1000 }];
  const RECONFIGURE = ['mode', 'photoSize', 'viewfinder', 'video'];
  const SOUNDS = {
    shutter: 'http://camera.localhost/resources/sounds/shutter.ogg',
    timer: 'http://camera.localhost/resources/sounds/timer.opus',
    start: 'http://camera.localhost/resources/sounds/camcorder_start.ogg',
    end: 'http://camera.localhost/resources/sounds/camcorder_end.ogg',
  };
  const HDR_CODE = '437';

  const asked = location.hash === '#activity';

  let camera = null;
  let opening = false;
  let caps = null;
  let table = null;
  let list = null;
  let settings = null;
  let current = null;
  let chain = Promise.resolve();
  let view = 'camera';
  let state = 'opening';
  let zoomIndex = 0;
  let items = [];
  let shown = 0;
  let rowFocus = 0;
  let keys = {};
  let dialogKeys = null;
  let toastTimer = null;
  let zoomTimer = null;
  let countdown = null;
  let recording = null;
  let free = null;
  let place = null;
  let watchId = null;
  let wakeLock = null;
  let activity = null;
  let typed = '';
  let worker = null;
  const jobs = {};
  let jobId = 0;

  function readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (e) {
      return null;
    }
  }

  function save() {
    localStorage.setItem(SETTINGS, JSON.stringify(settings));
  }

  function work(op, data, progress) {
    if (!worker) {
      worker = new Worker('js/worker.js');
      worker.onmessage = (e) => {
        const job = jobs[e.data.id];
        if ('progress' in e.data) {
          if (job.progress) job.progress(e.data.progress);
          return;
        }
        delete jobs[e.data.id];
        if (e.data.error) {
          job.reject(new Error(e.data.error));
        } else {
          job.resolve(e.data);
        }
      };
    }
    const id = ++jobId;
    return new Promise((resolve, reject) => {
      jobs[id] = { resolve, reject, progress };
      worker.postMessage(Object.assign({ id, op }, data));
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
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2500);
  }

  function status(text) {
    el.status.textContent = text;
  }

  function closeDialog() {
    el.dialog.classList.remove('show');
    dialogKeys = null;
    render();
  }

  function ask(text, ok, onOk) {
    el.dialogText.textContent = text;
    el.dialog.classList.add('show');
    dialogKeys = {
      SoftLeft: closeDialog,
      SoftRight: () => {
        closeDialog();
        onOk();
      },
      Backspace: closeDialog,
    };
    softkeys('Cancel', '', ok);
  }

  function play(name) {
    if (!settings.sound) {
      return;
    }
    const a = new Audio(SOUNDS[name]);
    a.mozAudioChannelType = 'notification';
    a.play().catch(() => {});
  }

  function blink() {
    el.blink.classList.add('on');
    setTimeout(() => el.blink.classList.remove('on'), 90);
  }

  function holdScreen(on) {
    if (on && !wakeLock) {
      wakeLock = navigator.b2g.requestWakeLock('screen');
    } else if (!on && wakeLock) {
      wakeLock.unlock();
      wakeLock = null;
    }
  }

  const pictures = () => navigator.b2g.getDeviceStorage('pictures');
  const videos = () => navigator.b2g.getDeviceStorage('videos');

  function exists(storage, path) {
    return storage.get(path).then(() => true, () => false);
  }

  function refreshRoom() {
    const storage = settings.mode === 'video' ? videos() : pictures();
    storage.freeSpace().then((bytes) => {
      free = bytes;
      renderTop();
    });
  }

  async function keep(blob, tag) {
    const storage = pictures();
    const date = new Date();
    for (let n = 0; ; n++) {
      const path = M.fileName('IMG', date, 'jpg', [tag, n || ''].filter(Boolean).join('_'));
      if (n < 20 && await exists(storage, path)) {
        continue;
      }
      await storage.addNamed(blob, path);
      const file = await storage.get(path);
      items.push({ path, file, video: false });
      refreshRoom();
      return;
    }
  }

  function whenWritten(storage, path) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = () => {
        storage.removeEventListener('change', onChange);
        clearTimeout(timer);
        storage.get(path).then(resolve, reject);
      };
      const onChange = (e) => {
        if (e.reason === 'modified' && e.path.endsWith(path)) {
          done();
        }
      };
      storage.addEventListener('change', onChange);
      timer = setTimeout(done, 8000);
    });
  }

  function geckoConfig(c) {
    const previewSize = M.previewSize(caps, c.aspect);
    return c.mode === 'video' ? { mode: 'video', recorderProfile: c.profile.name, previewSize }
      : { mode: 'picture', pictureSize: c.pictureSize, previewSize };
  }

  function wanted() {
    const c = M.configuration(settings.mode, settings, table, list);
    if (c.mode === 'video' && activity && activity.maxFileSizeBytes) {
      const p = M.mmsProfile(list);
      return { mode: 'video', profile: p, aspect: p.width / p.height };
    }
    return c;
  }

  function photoOption() {
    return table.photoSize.options.find((o) => o.value === settings.photoSize);
  }

  function reconfigure() {
    chain = chain.then(configure).catch((e) => toast(`The camera didn't take that: ${e.message || e}`, true));
    return chain;
  }

  async function configure() {
    if (!camera) {
      return;
    }
    const want = wanted();
    const gecko = geckoConfig(want);
    const key = JSON.stringify(gecko);
    if (key !== current.key) {
      const result = await camera.setConfiguration(gecko);
      current = { key, previewSize: result.previewSize };
      localStorage.setItem(CONFIG, key);
    }
    current.want = want;
    if (want.pictureSize) {
      camera.setPictureSize(want.pictureSize);
    }
    applyControls();
    layout();
    render();
  }

  function flashMode() {
    if (settings.mode === 'video') {
      return settings.light ? 'torch' : 'off';
    }
    return settings.mode === 'photo' ? settings.flash : 'off';
  }

  function clampEv(v) {
    return Math.max(caps.minExposureCompensation, Math.min(caps.maxExposureCompensation, v));
  }

  function baseEv() {
    return clampEv(settings.ev + (settings.mode === 'night' ? settings.nightBoost : 0));
  }

  function applyControls() {
    camera.flashMode = flashMode();
    camera.exposureCompensation = baseEv();
    camera.whiteBalanceMode = settings.wb;
    el.preview.style.filter = settings.mode === 'video' ? '' : M.lookCss(settings.effect);
    camera.setMeteringAreas(settings.metering === 'spot' ? SPOT : []);
    const remade = settings.mode !== 'photo' || photoOption().crop || settings.effect !== 'none';
    camera.pictureQuality = remade ? 1 : settings.quality / 100;
    camera.zoom = caps.zoomRatios[zoomIndex];
  }

  function layout() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const size = current.previewSize;
    const angle = camera.sensorAngle;
    const turned = angle % 180 !== 0;
    const dw = turned ? size.height : size.width;
    const dh = turned ? size.width : size.height;
    const scale = Math.max(W / dw, H / dh);
    Object.assign(el.preview.style, {
      width: `${size.width * scale}px`,
      height: `${size.height * scale}px`,
      transform: `translate(-50%, -50%) rotate(${angle}deg)`,
    });
    const sw = Math.min(W, dw * scale);
    const sh = Math.min(H, dh * scale);
    let r = { x: (W - sw) / 2, y: (H - sh) / 2, width: sw, height: sh };
    const crop = settings.mode !== 'video' && photoOption().crop;
    if (crop) {
      const c = M.cropRect(sw, sh, crop);
      r = { x: r.x + c.x, y: r.y + c.y, width: c.width, height: c.height };
    }
    Object.assign(el.picture.style, {
      left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px`,
    });
  }

  function onClose(e) {
    if (e.reason === 'HardwareReleased') {
      return;
    }
    if (countdown) {
      cancelTimer();
    }
    camera = null;
    if (recording) {
      stopRecording();
    }
    state = 'opening';
    status('The camera closed');
    render();
    setTimeout(openCamera, 1000);
  }

  function onRecorderState(e) {
    if (e.newState === 'FileSizeLimitReached' || e.newState === 'VideoLengthLimitReached') {
      stopRecording();
    } else if (e.newState === 'MediaRecorderFailed') {
      toast('Recording failed', true);
      stopRecording();
    }
  }

  async function getCamera() {
    const cached = readJson(CONFIG);
    try {
      return { r: await navigator.b2g.cameras.getCamera('back', cached || { mode: 'picture' }), cached };
    } catch (e) {
      if (!cached) {
        throw e;
      }
      localStorage.removeItem(CONFIG);
      return { r: await navigator.b2g.cameras.getCamera('back', { mode: 'picture' }), cached: null };
    }
  }

  async function openCamera() {
    if (camera || opening || document.hidden) {
      return;
    }
    opening = true;
    try {
      const { r, cached } = await getCamera();
      if (document.hidden) {
        r.camera.release();
        return;
      }
      camera = r.camera;
      caps = camera.capabilities;
      list = M.profiles(caps);
      table = M.choices(caps);
      settings = M.settle(Object.assign({}, readJson(SETTINGS), settings), table);
      if (activity && !allowedModes().includes(settings.mode)) {
        settings.mode = allowedModes()[0];
      }
      zoomIndex = Math.min(zoomIndex, caps.zoomRatios.length - 1);
      current = { key: JSON.stringify(cached || { mode: 'picture' }), previewSize: r.configuration.previewSize };
      camera.addEventListener('shutter', onShutter);
      camera.addEventListener('close', onClose);
      camera.addEventListener('recorderstatechange', onRecorderState);
      el.preview.mozSrcObject = camera;
      el.preview.play();
      state = 'idle';
      status('');
      await reconfigure();
      watchPlace();
      refreshRoom();
    } catch (e) {
      status(`The camera can't be opened (${e.name || e})`);
      setTimeout(openCamera, 2000);
    } finally {
      opening = false;
      render();
    }
  }

  async function releaseCamera() {
    if (countdown) {
      cancelTimer();
    }
    if (recording) {
      await stopRecording();
    }
    watchPlace();
    if (camera) {
      const c = camera;
      camera = null;
      state = 'opening';
      el.preview.mozSrcObject = null;
      await c.release();
    }
  }

  function watchPlace() {
    const want = settings && settings.geotag && camera && !document.hidden;
    if (want && watchId === null) {
      watchId = navigator.geolocation.watchPosition((p) => {
        place = { latitude: p.coords.latitude, longitude: p.coords.longitude, altitude: p.coords.altitude || 0,
          timestamp: p.timestamp };
      }, () => {
      }, { enableHighAccuracy: true, maximumAge: 60000 });
    } else if (!want && watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
      place = null;
    }
  }

  let quietShutter = false;

  function onShutter() {
    blink();
    if (!quietShutter) {
      play('shutter');
    }
  }

  async function capture(pictureSize) {
    if (!camera) {
      throw new Error('the camera closed');
    }
    const options = { pictureSize, fileFormat: 'jpeg', rotation: settings.hold };
    if (settings.geotag && place) {
      options.position = place;
    }
    const blob = await camera.takePicture(options);
    camera.resumePreview();
    return blob;
  }

  function busy(next, text) {
    state = next;
    status(text || '');
    render();
  }

  async function shootPhoto(option) {
    busy('shooting');
    const raw = await capture(option.size);
    if (!option.crop && settings.effect === 'none') {
      await keep(raw);
      return;
    }
    busy('processing', 'Saving…');
    const r = await work('finish', { blob: raw, quality: settings.quality, aspect: option.crop, look: settings.effect });
    await keep(r.blob);
  }

  async function burst(evs, option, label) {
    await work('clear');
    const looked = [];
    for (let k = 0; k < evs.length; k++) {
      busy('shooting', `${label}: hold still ${k + 1}/${evs.length}`);
      camera.exposureCompensation = clampEv(baseEv() + evs[k]);
      const blob = await capture(option.size);
      quietShutter = true;
      looked.push(work('shot', { blob, ev: evs[k] }));
    }
    quietShutter = false;
    camera.exposureCompensation = baseEv();
    busy('processing', `${label}…`);
    await Promise.all(looked);
  }

  async function shootMerged(op, evs, label, option) {
    holdScreen(true);
    try {
      await burst(evs, option, label);
      const r = await work(op, { quality: settings.quality, aspect: option.crop, look: settings.effect },
        (p) => status(`${label} ${Math.round(p * 100)}%`));
      if (settings.keepOriginal) {
        await keep(r.plain);
      }
      await keep(r.blob, op.toUpperCase());
    } finally {
      quietShutter = false;
      holdScreen(false);
    }
  }

  async function shootNow() {
    const option = photoOption();
    busy('shooting');
    try {
      if (settings.mode === 'night') {
        await shootMerged('night', new Array(settings.nightFrames).fill(0), 'Night', option);
      } else if (settings.mode === 'hdr') {
        const b = settings.hdrBracket;
        await shootMerged('hdr', [0, -b, b], 'HDR', option);
      } else {
        await shootPhoto(option);
      }
      if (activity) {
        state = 'idle';
        showReview(items.length - 1);
        return;
      }
    } catch (e) {
      toast(`No photo: ${e.message || e.name || e}`, true);
    } finally {
      if (camera) {
        applyControls();
      }
      state = camera ? 'idle' : 'opening';
      status('');
      render();
    }
  }

  function startTimer(seconds) {
    const light = settings.timerLight && table.timerLight && settings.mode !== 'video';
    let left = seconds;
    countdown = { timers: [] };
    busy('timer');
    const flash = (at) => countdown.timers.push(setTimeout(() => {
      camera.flashMode = 'torch';
      countdown.timers.push(setTimeout(() => {
        camera.flashMode = flashMode();
      }, 120));
    }, at));
    const tick = () => {
      if (left === 0) {
        countdown = null;
        shootNow();
        return;
      }
      status(String(left));
      play('timer');
      if (light) {
        flash(0);
        if (left <= 3) {
          flash(500);
        }
      }
      left--;
      countdown.timers.push(setTimeout(tick, 1000));
    };
    tick();
  }

  function cancelTimer() {
    countdown.timers.forEach(clearTimeout);
    countdown = null;
    if (camera) {
      camera.flashMode = flashMode();
    }
    state = 'idle';
    status('');
    render();
  }

  function shoot() {
    if (settings.timer) {
      startTimer(settings.timer);
    } else {
      shootNow();
    }
  }

  function partName(path, n) {
    return path.replace(/\.(\w+)$/, `_part${n}.$1`);
  }

  async function startPart(r) {
    const path = r.parts.length ? partName(r.path, r.parts.length + 1) : r.path;
    const options = { rotation: settings.hold };
    if (activity && activity.maxFileSizeBytes) {
      options.maxFileSizeBytes = activity.maxFileSizeBytes - r.bytes;
    }
    await camera.startRecording(options, r.storage, path);
    r.parts.push(path);
  }

  async function endPart(r) {
    const written = whenWritten(r.storage, r.parts[r.parts.length - 1]);
    if (camera) {
      camera.stopRecording();
    }
    const file = await written;
    r.files.push(file);
    r.bytes += file.size;
  }

  async function record() {
    const p = current.want.profile;
    const storage = videos();
    const date = new Date();
    busy('shooting');
    let path = null;
    for (let n = 0; !path; n++) {
      const name = M.fileName('VID', date, p.ext, n || '');
      if (n >= 20 || !(await exists(storage, name))) {
        path = name;
      }
    }
    const r = { path, storage, mime: p.mime, parts: [], files: [], bytes: 0, paused: 0, pausedAt: 0,
      step: Promise.resolve() };
    try {
      const probe = path.replace(/[^/]*$/, `.probe.${p.ext}`);
      await storage.addNamed(new Blob([], { type: p.mime }), probe);
      await storage.delete(probe);
      play('start');
      await startPart(r);
    } catch (e) {
      toast(`Can't record: ${e.message || e.name || e}`, true);
      busy('idle');
      return;
    }
    r.started = Date.now();
    r.timer = setInterval(showRecordingTime, 500);
    recording = r;
    holdScreen(true);
    busy('recording');
    showRecordingTime();
  }

  function showRecordingTime() {
    const r = recording;
    const now = r.pausedAt || Date.now();
    status(M.duration(now - r.started - r.paused));
  }

  function queue(r, step) {
    r.step = r.step.then(step).catch((e) => {
      toast(`Recording stopped: ${e.message || e.name || e}`, true);
      stopRecording();
    });
  }

  function pauseOrResume() {
    const r = recording;
    if (r.pausedAt) {
      state = 'resuming';
      queue(r, async () => {
        await startPart(r);
        r.paused += Date.now() - r.pausedAt;
        r.pausedAt = 0;
        if (recording === r) {
          state = 'recording';
          render();
        }
      });
    } else {
      r.pausedAt = Date.now();
      state = 'paused';
      queue(r, () => endPart(r));
    }
    showRecordingTime();
    render();
  }

  async function joinParts(r) {
    const folder = await (await r.storage.getRoot()).get(r.path.replace(/\/[^/]*$/, ''));
    const first = partName(r.path, 1);
    await folder.renameTo(r.path.split('/').pop(), first.split('/').pop());
    r.parts[0] = first;
    r.files[0] = await r.storage.get(first);
    await r.storage.addNamed(await window.CameraMp4.join(r.files), r.path);
    await Promise.all(r.parts.map((p) => r.storage.delete(p)));
    return r.storage.get(r.path);
  }

  async function stopRecording() {
    const r = recording;
    if (!r) {
      return;
    }
    recording = null;
    clearInterval(r.timer);
    busy('processing', 'Saving…');
    await r.step;
    const ending = r.files.length < r.parts.length && endPart(r);
    play('end');
    try {
      await ending;
      let file = r.files[0];
      if (r.files.length > 1) {
        try {
          file = await joinParts(r);
        } catch (e) {
          toast(`Kept in ${r.parts.length} parts: ${e.message || e.name || e}`, true);
          return;
        }
      }
      items.push({ path: r.path, file, video: true, mime: r.mime });
      refreshRoom();
      if (activity) {
        state = 'idle';
        showReview(items.length - 1);
      }
    } catch (e) {
      toast(`The video wasn't saved: ${e.message || e.name || e}`, true);
    } finally {
      holdScreen(false);
      state = camera ? 'idle' : 'opening';
      status('');
      render();
    }
  }

  async function snapshot() {
    try {
      const blob = await camera.takePicture({ pictureSize: photoOption().size, fileFormat: 'jpeg',
        rotation: settings.hold });
      await keep(blob);
      toast('Photo saved');
    } catch (e) {
      toast(`No photo: ${e.message || e.name || e}`, true);
    }
  }

  function allowedModes() {
    const all = M.modes(settings);
    if (!activity) {
      return all;
    }
    return all.filter((m) => (m === 'video' ? activity.video : activity.photo));
  }

  function typeDigit(d) {
    typed = (typed + d).slice(-HDR_CODE.length);
    if (typed !== HDR_CODE) {
      return;
    }
    typed = '';
    settings.hdrUnlocked = !settings.hdrUnlocked;
    save();
    if (!settings.hdrUnlocked && settings.mode === 'hdr') {
      set('mode', 'photo');
      renderOptions();
    }
    toast(settings.hdrUnlocked ? 'HDR mode unlocked' : 'HDR mode hidden');
  }

  function set(key, value, say) {
    settings[key] = value;
    save();
    if (RECONFIGURE.includes(key)) {
      reconfigure();
    } else if (camera) {
      applyControls();
    }
    if (key === 'geotag') {
      watchPlace();
    }
    if (key === 'mode') {
      refreshRoom();
    }
    render();
    if (say) {
      toast(`${table[key].label}: ${M.label(table, key, value)}`);
    }
  }

  function cycle(key, by = 1) {
    if (table[key] && M.rows(settings.mode, table).includes(key)) {
      set(key, M.step(table, settings, key, by), true);
    }
  }

  function nudgeEv(by) {
    set('ev', by ? M.nudge(table, settings, 'ev', by) : 0, true);
  }

  function switchMode(by) {
    const modes = allowedModes();
    const i = modes.indexOf(settings.mode);
    set('mode', modes[(i + by + modes.length) % modes.length]);
  }

  function toggleLight() {
    if (settings.mode === 'video') {
      set('light', !settings.light, true);
    } else if (settings.mode === 'photo') {
      set('flash', settings.flash === 'torch' ? 'off' : 'torch', true);
    }
  }

  function nextSpeed() {
    if (settings.mode === 'video') {
      const lines = settings.video.split('/')[0];
      const same = table.video.options.filter((o) => o.value.startsWith(`${lines}/`)).map((o) => o.value);
      set('video', same[(same.indexOf(settings.video) + 1) % same.length], true);
    } else {
      cycle('viewfinder');
    }
  }

  function zoom(by) {
    const n = caps.zoomRatios.length;
    zoomIndex = Math.max(0, Math.min(n - 1, zoomIndex + by));
    camera.zoom = caps.zoomRatios[zoomIndex];
    el.zoom.textContent = `${caps.zoomRatios[zoomIndex].toFixed(1)}×`;
    el.zoom.classList.add('show');
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => el.zoom.classList.remove('show'), 1500);
  }

  function optionKeys() {
    return M.rows(settings.mode, table).concat(['help']);
  }

  function renderOptions() {
    const all = optionKeys();
    rowFocus = Math.min(rowFocus, all.length - 1);
    el.rows.textContent = '';
    all.forEach((key, i) => {
      const row = document.createElement('div');
      row.className = `row${key === 'help' ? ' action' : ''}${i === rowFocus ? ' focus' : ''}`;
      const name = document.createElement('p');
      name.className = 'name';
      name.textContent = key === 'help' ? 'Keys' : table[key].label;
      const value = document.createElement('p');
      value.className = 'value';
      value.textContent = key === 'help' ? 'What each key does' : M.label(table, key, settings[key]);
      row.append(name, value);
      el.rows.appendChild(row);
    });
    el.rows.children[rowFocus].scrollIntoView({ block: 'nearest' });
  }

  function change(by) {
    const key = optionKeys()[rowFocus];
    if (key === 'help') {
      showKeys();
      return;
    }
    set(key, M.step(table, settings, key, by));
    renderOptions();
  }

  function moveRow(by) {
    const n = optionKeys().length;
    rowFocus = (rowFocus + by + n) % n;
    renderOptions();
  }

  function showOptions() {
    view = 'options';
    renderOptions();
    render();
  }

  function keyGroups() {
    const modes = allowedModes().map((m) => M.MODE_NAMES[m]).join(', ');
    return [
      ['Shooting', [
        ['OK', 'Take the photo, or start and stop a video'],
        [['arrow-left', 'arrow-right'], `Mode: ${modes}`],
        [['arrow-up', 'arrow-down'], 'Zoom; hold to zoom faster'],
        ['Left soft', 'The last photo or video'],
        ['Right soft', 'Options'],
      ]],
      ['Settings', [
        ['1', 'Flash (Video: the light)'],
        ['0', 'Light on and off'],
        ['2  8', 'Exposure up, down'],
        ['5', 'Exposure back to 0'],
        ['4  6', 'White balance'],
        ['3', 'Timer'],
        ['7', 'Grid'],
        ['*', 'Colour (photos)'],
        ['#', 'Viewfinder speed (Video: frame rate)'],
      ]],
      ['Recording', [
        ['OK', 'Stop'],
        ['Left soft', 'Pause and resume'],
        ['Right soft', 'Take a photo'],
      ]],
      ['Looking back', [
        [['arrow-left', 'arrow-right'], 'Earlier, later'],
        ['OK', 'Play and pause a video'],
        ['Left soft', 'Share'],
        ['Right soft', 'Delete'],
      ]],
    ];
  }

  function showKeys() {
    const out = [];
    keyGroups().forEach(([title, rows]) => {
      const h = document.createElement('h2');
      h.textContent = title;
      out.push(h);
      rows.forEach(([key, does]) => {
        const row = document.createElement('div');
        row.className = 'key-row';
        const k = document.createElement('span');
        k.className = 'key';
        if (Array.isArray(key)) {
          key.forEach((name) => {
            const i = document.createElement('i');
            i.dataset.icon = name;
            k.appendChild(i);
          });
        } else {
          k.textContent = key;
        }
        const d = document.createElement('span');
        d.className = 'does';
        d.textContent = does;
        row.append(k, d);
        out.push(row);
      });
    });
    el.keyList.replaceChildren(...out);
    el.keyList.scrollTop = 0;
    view = 'keys';
    render();
  }

  let reviewUrls = [];

  function forgetUrls() {
    reviewUrls.forEach((u) => URL.revokeObjectURL(u));
    reviewUrls = [];
  }

  function showReview(index) {
    view = 'review';
    shown = index;
    const item = items[shown];
    forgetUrls();
    const url = URL.createObjectURL(item.file);
    reviewUrls.push(url);
    el.review.classList.toggle('video', item.video);
    if (item.video) {
      el.reviewVideo.src = url;
      el.reviewImage.removeAttribute('src');
    } else {
      el.reviewImage.src = url;
      el.reviewVideo.removeAttribute('src');
    }
    const name = item.path.split('/').pop();
    const mb = (item.file.size / 1e6).toFixed(1);
    el.reviewInfo.textContent = `${shown + 1}/${items.length}  ${name}  ${mb} MB`;
    render();
  }

  function leaveReview() {
    el.reviewVideo.pause();
    el.reviewVideo.removeAttribute('src');
    el.reviewImage.removeAttribute('src');
    forgetUrls();
    view = 'camera';
    render();
  }

  function share(item) {
    new WebActivity('share', {
      type: item.video ? 'video/*' : 'image/*', number: 1, blobs: [item.file],
      filenames: [item.path.split('/').pop()], filepaths: [item.path],
    }).start().catch(() => {
    });
  }

  function remove(item) {
    ask(`Delete ${item.path.split('/').pop()}?`, 'Delete', async () => {
      try {
        await (item.video ? videos() : pictures()).delete(item.path);
      } catch (e) {
        toast(`Not deleted: ${e.name || e}`, true);
        return;
      }
      items.splice(shown, 1);
      refreshRoom();
      if (items.length) {
        showReview(Math.min(shown, items.length - 1));
      } else {
        leaveReview();
      }
    });
  }

  function gallery() {
    const video = settings.mode === 'video';
    new WebActivity('browse', { type: video ? ['video/mp4'] : 'photos' }).start().catch(() => {
    });
  }

  function startActivity(source) {
    const data = source.data || {};
    const types = [].concat(data.type || []);
    const video = types.some((t) => /video/.test(t));
    const photo = types.some((t) => /image|photo/.test(t)) || !video;
    activity = { name: source.name, video, photo, maxFileSizeBytes: data.maxFileSizeBytes || 0 };
    if (settings && !allowedModes().includes(settings.mode)) {
      set('mode', allowedModes()[0]);
    }
    render();
  }

  function answer(message) {
    navigator.serviceWorker.controller.postMessage(message);
    window.close();
  }

  async function deliver(item) {
    let blob = item.file;
    if (!item.video && activity.maxFileSizeBytes && blob.size > activity.maxFileSizeBytes) {
      busy('processing', 'Making it smaller…');
      blob = (await work('fit', { blob, maxBytes: activity.maxFileSizeBytes })).blob;
    }
    answer({ result: { blob, type: item.video ? item.mime : 'image/jpeg', filename: item.path.split('/').pop() } });
  }

  function cameraKeys() {
    if (state === 'timer') {
      return { keys: { Enter: cancelTimer, Backspace: cancelTimer }, labels: ['', 'Cancel', ''] };
    }
    if (state === 'recording' || state === 'paused') {
      return {
        keys: {
          Enter: stopRecording, Backspace: stopRecording, SoftLeft: pauseOrResume, SoftRight: snapshot,
          ArrowUp: (e) => zoom(e.repeat ? 4 : 2), ArrowDown: (e) => zoom(e.repeat ? -4 : -2), 0: toggleLight,
        },
        labels: [state === 'paused' ? 'Resume' : 'Pause', 'Stop', 'Photo'],
      };
    }
    const back = activity ? () => answer({ error: 'cancelled' }) : () => window.close();
    if (state !== 'idle') {
      return { keys: { Backspace: state === 'opening' ? back : null }, labels: ['', '', ''] };
    }
    const last = items.length ? () => showReview(items.length - 1) : null;
    const left = last || (activity ? null : gallery);
    return {
      keys: {
        Enter: settings.mode === 'video' ? record : shoot,
        SoftLeft: left,
        SoftRight: showOptions,
        Backspace: back,
        ArrowLeft: () => switchMode(-1),
        ArrowRight: () => switchMode(1),
        ArrowUp: (e) => zoom(e.repeat ? 4 : 2),
        ArrowDown: (e) => zoom(e.repeat ? -4 : -2),
        1: () => cycle(settings.mode === 'video' ? 'light' : 'flash'),
        2: () => nudgeEv(1),
        8: () => nudgeEv(-1),
        5: () => nudgeEv(0),
        4: () => cycle('wb', -1),
        6: () => cycle('wb', 1),
        3: () => cycle('timer'),
        7: () => set('grid', !settings.grid, true),
        '*': () => cycle('effect'),
        '#': nextSpeed,
        0: toggleLight,
      },
      labels: [last ? 'Last' : left ? 'Gallery' : '', settings.mode === 'video' ? 'Record' : 'Shoot', 'Options'],
    };
  }

  function reviewKeys() {
    const item = items[shown];
    const video = el.reviewVideo;
    const keysOf = {
      ArrowLeft: () => shown > 0 && showReview(shown - 1),
      ArrowRight: () => shown < items.length - 1 && showReview(shown + 1),
      Enter: item.video ? () => (video.paused ? video.play() : video.pause()) : null,
      Backspace: leaveReview,
    };
    const center = item.video ? (video.paused ? 'Play' : 'Pause') : '';
    if (activity) {
      Object.assign(keysOf, { SoftLeft: leaveReview, SoftRight: () => deliver(item) });
      return { keys: keysOf, labels: ['Retake', center, 'Select'] };
    }
    Object.assign(keysOf, { SoftLeft: () => share(item), SoftRight: () => remove(item) });
    return { keys: keysOf, labels: ['Share', center, 'Delete'] };
  }

  function updateKeys() {
    if (dialogKeys) {
      return;
    }
    let k;
    if (view === 'options') {
      const back = () => {
        view = 'camera';
        render();
      };
      const digits = Object.fromEntries('0123456789'.split('').map((d) => [d, () => typeDigit(d)]));
      k = {
        keys: Object.assign(digits, {
          ArrowUp: () => moveRow(-1), ArrowDown: () => moveRow(1), ArrowLeft: () => change(-1),
          ArrowRight: () => change(1), Enter: () => change(1), SoftRight: back, Backspace: back,
        }),
        labels: ['', 'Change', 'Done'],
      };
    } else if (view === 'keys') {
      const back = () => {
        view = 'options';
        render();
      };
      k = {
        keys: {
          ArrowUp: () => el.keyList.scrollBy(0, -48), ArrowDown: () => el.keyList.scrollBy(0, 48),
          Enter: back, SoftRight: back, Backspace: back,
        },
        labels: ['', '', 'Done'],
      };
    } else if (view === 'review') {
      k = reviewKeys();
    } else {
      k = settings ? cameraKeys() : { keys: { Backspace: () => window.close() }, labels: ['', '', ''] };
    }
    keys = k.keys;
    softkeys(...k.labels);
  }

  function icon(name, text) {
    const s = document.createElement('span');
    if (name) {
      const i = document.createElement('i');
      i.dataset.icon = name;
      s.appendChild(i);
    }
    if (text) {
      s.appendChild(document.createTextNode(text));
    }
    return s;
  }

  function renderTop() {
    if (!settings) {
      return;
    }
    el.mode.textContent = M.MODE_NAMES[settings.mode];
    const out = [];
    const video = settings.mode === 'video';
    const flash = flashMode();
    if (flash !== 'off') {
      out.push(icon({ auto: 'flash-auto', on: 'flash-on', torch: 'flashlight-on' }[flash]));
    }
    if (settings.mode === 'night') {
      out.push(icon('moon', `×${settings.nightFrames}`));
    }
    if (settings.mode === 'hdr') {
      out.push(icon(null, `±${settings.hdrBracket}`));
    }
    const want = current && current.want;
    if (want && want.mode === 'video') {
      out.push(icon(null, `${want.profile.fps} fps`));
    }
    if (settings.timer && !video) {
      out.push(icon('camera-timer', `${settings.timer}`));
    }
    if (Math.abs(baseEv()) > 0.01) {
      out.push(icon('brightness', M.formatEv(baseEv())));
    }
    if (settings.wb !== 'auto') {
      out.push(icon(null, M.label(table, 'wb', settings.wb)));
    }
    if (settings.effect !== 'none' && !video) {
      out.push(icon(null, M.label(table, 'effect', settings.effect)));
    }
    if (settings.geotag && !video) {
      out.push(icon(place ? 'location' : null, place ? '' : 'No fix'));
    }
    if (free !== null) {
      out.push(icon(null, M.room(free, settings.mode, settings, table)));
    }
    el.icons.replaceChildren(...out);
  }

  function render() {
    el.body.dataset.view = view;
    el.body.dataset.state = state;
    if (settings) {
      el.body.dataset.mode = settings.mode;
      el.body.classList.toggle('grid', settings.grid);
    }
    renderTop();
    updateKeys();
  }

  function onKey(e) {
    const name = { GoBack: 'Backspace', Camera: 'Enter' }[e.key] || e.key;
    const fn = (dialogKeys || keys)[name];
    if (fn) {
      e.preventDefault();
      fn(e);
    } else if (name === 'Backspace') {
      e.preventDefault();
    }
  }

  window.addEventListener('keydown', onKey);
  el.reviewVideo.addEventListener('play', render);
  el.reviewVideo.addEventListener('pause', render);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      openCamera();
    } else if (activity) {
      answer({ error: 'cancelled' });
    } else {
      releaseCamera();
    }
  });

  if (asked) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data.source) {
        startActivity(e.data.source);
      }
    });
    setInterval(() => navigator.serviceWorker.controller &&
      navigator.serviceWorker.controller.postMessage({ keepAlive: true }), 60000);
  }
  render();
  openCamera();
}());

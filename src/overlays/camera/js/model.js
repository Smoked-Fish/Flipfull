'use strict';

(function (exports) {
  const DIR = 'DCIM/100MZLLA/';
  const MODES = ['photo', 'night', 'hdr', 'video'];
  const MODE_NAMES = { photo: 'Photo', night: 'Night', hdr: 'HDR', video: 'Video' };

  const WB_NAMES = {
    auto: 'Auto', daylight: 'Daylight', 'cloudy-daylight': 'Cloudy', shade: 'Shade', twilight: 'Twilight',
    fluorescent: 'Fluorescent', 'warm-fluorescent': 'Warm fluorescent', incandescent: 'Incandescent',
  };
  const LOOKS = [
    { value: 'none', label: 'Natural', filters: [] },
    { value: 'vivid', label: 'Vivid', filters: [['saturate', 1.5], ['contrast', 1.1]] },
    { value: 'warm', label: 'Warm', filters: [['sepia', 0.3], ['saturate', 1.3]] },
    { value: 'faded', label: 'Faded', filters: [['contrast', 0.85], ['brightness', 1.08], ['saturate', 0.75]] },
    { value: 'mono', label: 'Mono', filters: [['grayscale', 1]] },
    { value: 'noir', label: 'Noir', filters: [['grayscale', 1], ['contrast', 1.45]] },
    { value: 'sepia', label: 'Sepia', filters: [['sepia', 1]] },
    { value: 'document', label: 'Document', filters: [['grayscale', 1], ['contrast', 1.8], ['brightness', 1.15]] },
    { value: 'negative', label: 'Negative', filters: [['invert', 1]] },
  ];
  const FLASH_NAMES = { off: 'Off', auto: 'Auto', on: 'On', torch: 'Light' };
  const VIEWFINDERS = [
    { value: 'smooth', fps: 24, label: 'Smooth (24 fps)' },
    { value: 'bright', fps: 15, label: 'Bright (15 fps)' },
    { value: 'auto', fps: null, label: 'Auto (10-30 fps)' },
  ];

  const RATE_NAMES = { 30: 'slows in the dark', 24: 'steady' };

  const onOff = [{ value: false, label: 'Off' }, { value: true, label: 'On' }];

  function aspectOf(w, h) {
    return Math.max(w, h) / Math.min(w, h);
  }

  function sameAspect(a, b) {
    return Math.abs(a - b) < 0.01;
  }

  function profiles(caps) {
    const rp = caps.recorderProfiles;
    return Object.keys(rp).filter((name) => name !== 'default').map((name) => {
      const v = rp[name].video;
      return {
        name, width: v.size.width, height: v.size.height, fps: v.framesPerSecond, bps: v.bitsPerSecond,
        mime: rp[name].mimeType, ext: rp[name].containerFormat === '3gp' ? '3gp' : 'mp4',
      };
    });
  }

  function smallestFirst(a, b) {
    return a.width * a.height - b.width * b.height;
  }

  function viewfinderProfile(list, aspect, fps) {
    const fit = list.filter((p) => p.fps === fps && sameAspect(aspectOf(p.width, p.height), aspect));
    return fit.sort(smallestFirst)[0] || null;
  }

  function videoOptions(list) {
    return list.filter((p) => sameAspect(aspectOf(p.width, p.height), 16 / 9) && Math.min(p.width, p.height) >= 720)
      .sort((a, b) => b.height * b.width - a.height * a.width || b.fps - a.fps)
      .map((p) => {
        const lines = Math.min(p.width, p.height);
        const name = RATE_NAMES[p.fps];
        return { value: `${lines}/${p.fps}`, label: `${lines}p ${p.fps} fps${name ? `, ${name}` : ''}`, profile: p };
      });
  }

  function mmsProfile(list) {
    return list.slice().sort(smallestFirst)[0];
  }

  function megapixels(w, h) {
    return `${(w * h / 1e6).toFixed(1)} MP`;
  }

  function cropRect(w, h, aspect) {
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    let cl = long;
    let cs = Math.round(long / aspect);
    if (cs > short) {
      cs = short;
      cl = Math.round(short * aspect);
    }
    const cw = w >= h ? cl : cs;
    const ch = w >= h ? cs : cl;
    return { x: (w - cw) >> 1, y: (h - ch) >> 1, width: cw, height: ch };
  }

  function photoSizes(caps) {
    const four3 = caps.pictureSizes.filter((s) => sameAspect(aspectOf(s.width, s.height), 4 / 3))
      .sort((a, b) => b.width * b.height - a.width * a.height);
    const full = four3[0];
    const out = [{ value: '4:3', label: `4:3 · ${megapixels(full.width, full.height)}`, size: full, crop: null }];
    [['16:9', 16 / 9], ['1:1', 1]].forEach(([value, aspect]) => {
      const r = cropRect(full.width, full.height, aspect);
      out.push({ value, label: `${value} · ${megapixels(r.width, r.height)}`, size: full, crop: aspect });
    });
    four3.slice(1).filter((s) => s.width * s.height >= 1e6).forEach((s) => {
      const label = `4:3 · ${megapixels(s.width, s.height)}`;
      if (!out.some((o) => o.label === label)) {
        out.push({ value: `4:3 ${s.width}`, label, size: s, crop: null });
      }
    });
    return out;
  }

  function formatEv(v) {
    if (Math.abs(v) < 0.01) {
      return '0';
    }
    return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1).replace(/\.0$/, '')}`;
  }

  function evSteps(caps) {
    const step = caps.exposureCompensationStep;
    const per = Math.max(1, Math.round((1 / 3) / step));
    const out = [];
    const lo = Math.ceil(caps.minExposureCompensation / (step * per) - 1e-6);
    const hi = Math.floor(caps.maxExposureCompensation / (step * per) + 1e-6);
    for (let k = lo; k <= hi; k++) {
      out.push(Math.round(k * per * step * 100) / 100);
    }
    return out;
  }

  function choices(caps) {
    const list = profiles(caps);
    const videos = videoOptions(list);
    const flash = caps.flashModes || [];
    const hasTorch = flash.includes('torch');
    const out = {
      photoSize: { label: 'Photo size', options: photoSizes(caps), default: '4:3' },
      quality: {
        label: 'JPEG quality',
        options: [{ value: 90, label: '90% (stock)' }, { value: 95, label: '95%' }, { value: 100, label: '100%' }],
        default: 95,
      },
      flash: {
        label: 'Flash',
        options: ['off', 'auto', 'on', 'torch'].filter((f) => flash.includes(f))
          .map((value) => ({ value, label: FLASH_NAMES[value] })),
        default: 'off',
      },
      light: { label: 'Light', options: onOff, default: false },
      ev: {
        label: 'Exposure',
        options: evSteps(caps).map((value) => ({ value, label: `${formatEv(value)} EV` })),
        default: 0,
      },
      nightBoost: {
        label: 'Night extra exposure',
        options: [0, 0.67, 1, 1.33, 2].map((value) => ({ value, label: `${formatEv(value)} EV` })),
        default: 1,
      },
      nightFrames: {
        label: 'Night shots',
        options: [4, 6, 8].map((value) => ({ value, label: `${value}` })),
        default: 6,
      },
      hdrBracket: {
        label: 'HDR bracket',
        options: [1, 1.5, 2].map((value) => ({ value, label: `±${value} EV` })),
        default: 2,
      },
      keepOriginal: { label: 'Also keep the plain photo', options: onOff, default: false },
      wb: {
        label: 'White balance',
        options: caps.whiteBalanceModes.filter((m) => WB_NAMES[m]).map((value) => ({ value, label: WB_NAMES[value] })),
        default: 'auto',
      },
      effect: {
        label: 'Colour',
        options: LOOKS.map(({ value, label }) => ({ value, label })),
        default: 'none',
      },
      metering: {
        label: 'Metering',
        options: [{ value: 'average', label: 'Whole picture' }]
          .concat(caps.maxMeteringAreas > 0 ? [{ value: 'spot', label: 'Centre spot' }] : []),
        default: 'average',
      },
      timer: {
        label: 'Timer',
        options: [0, 3, 5, 10].map((value) => ({ value, label: value ? `${value} s` : 'Off' })),
        default: 0,
      },
      timerLight: { label: 'Timer blinks the light', options: onOff, default: true },
      viewfinder: {
        label: 'Viewfinder',
        options: VIEWFINDERS.filter((v) => v.fps === null || viewfinderProfile(list, 4 / 3, v.fps)),
        default: 'smooth',
      },
      hold: {
        label: 'Holding the phone',
        options: [
          { value: 0, label: 'Upright' },
          { value: 270, label: 'Sideways, top left' },
          { value: 90, label: 'Sideways, top right' },
        ],
        default: 0,
      },
      grid: { label: 'Grid', options: onOff, default: false },
      geotag: { label: 'Location in photos', options: onOff, default: false },
      sound: { label: 'Shutter sound', options: onOff, default: true },
      video: { label: 'Video', options: videos, default: (videos.find((o) => o.profile.fps === 24) || videos[0]).value },
    };
    if (!hasTorch) {
      delete out.light;
      delete out.timerLight;
    }
    return out;
  }

  const ROWS = {
    photo: ['photoSize', 'quality', 'flash', 'ev', 'wb', 'effect', 'metering', 'timer', 'timerLight',
      'viewfinder', 'hold', 'grid', 'geotag', 'sound'],
    night: ['photoSize', 'quality', 'nightFrames', 'nightBoost', 'keepOriginal', 'ev', 'wb', 'effect', 'metering',
      'timer', 'timerLight', 'hold', 'grid', 'geotag', 'sound'],
    hdr: ['photoSize', 'quality', 'hdrBracket', 'keepOriginal', 'ev', 'wb', 'effect', 'metering', 'timer',
      'timerLight', 'viewfinder', 'hold', 'grid', 'geotag', 'sound'],
    video: ['video', 'light', 'ev', 'wb', 'metering', 'hold', 'grid', 'sound'],
  };

  function modes(settings) {
    return MODES.filter((m) => m !== 'hdr' || settings.hdrUnlocked);
  }

  function rows(mode, table) {
    return ROWS[mode].filter((key) => table[key] && table[key].options.length > 1);
  }

  function settle(saved, table) {
    const out = {};
    Object.keys(table).forEach((key) => {
      const values = table[key].options.map((o) => o.value);
      out[key] = values.includes(saved[key]) ? saved[key] : table[key].default;
      if (!values.includes(out[key])) {
        out[key] = values[0];
      }
    });
    out.hdrUnlocked = saved.hdrUnlocked === true;
    out.mode = modes(out).includes(saved.mode) ? saved.mode : 'photo';
    return out;
  }

  function step(table, settings, key, by) {
    const values = table[key].options.map((o) => o.value);
    const i = values.indexOf(settings[key]);
    return values[(i + by + values.length) % values.length];
  }

  function nudge(table, settings, key, by) {
    const values = table[key].options.map((o) => o.value);
    const i = values.indexOf(settings[key]);
    return values[Math.max(0, Math.min(values.length - 1, i + by))];
  }

  function label(table, key, value) {
    const o = table[key].options.find((x) => x.value === value);
    return o ? o.label : String(value);
  }

  function configuration(mode, settings, table, list) {
    if (mode === 'video') {
      const p = table.video.options.find((o) => o.value === settings.video).profile;
      return { mode: 'video', profile: p, aspect: aspectOf(p.width, p.height) };
    }
    const size = table.photoSize.options.find((o) => o.value === settings.photoSize).size;
    const aspect = aspectOf(size.width, size.height);
    const want = mode === 'night' ? 'bright' : settings.viewfinder;
    const vf = VIEWFINDERS.find((v) => v.value === want);
    const p = vf.fps ? viewfinderProfile(list, aspect, vf.fps) || viewfinderProfile(list, aspect, 24) : null;
    return p ? { mode: 'video', profile: p, aspect, pictureSize: size }
      : { mode: 'picture', profile: null, aspect, pictureSize: size };
  }

  function previewSize(caps, aspect) {
    const fit = caps.previewSizes.filter((s) => sameAspect(aspectOf(s.width, s.height), aspect))
      .sort(smallestFirst);
    return fit.find((s) => Math.min(s.width, s.height) >= 360) || fit[fit.length - 1] || caps.previewSizes[0];
  }

  function lookCss(value) {
    return LOOKS.find((l) => l.value === value).filters.map(([f, a]) => `${f}(${a})`).join(' ');
  }

  function filterMatrix(f, a) {
    const s = 1 - a;
    switch (f) {
      case 'grayscale':
        return [0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s, 0,
          0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s, 0,
          0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s, 0];
      case 'sepia':
        return [0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s, 0,
          0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s, 0,
          0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s, 0];
      case 'saturate':
        return [0.213 + 0.787 * a, 0.715 - 0.715 * a, 0.072 - 0.072 * a, 0,
          0.213 - 0.213 * a, 0.715 + 0.285 * a, 0.072 - 0.072 * a, 0,
          0.213 - 0.213 * a, 0.715 - 0.715 * a, 0.072 + 0.928 * a, 0];
      case 'contrast':
        return [a, 0, 0, (1 - a) / 2, 0, a, 0, (1 - a) / 2, 0, 0, a, (1 - a) / 2];
      case 'brightness':
        return [a, 0, 0, 0, 0, a, 0, 0, 0, 0, a, 0];
      case 'invert':
        return [1 - 2 * a, 0, 0, a, 0, 1 - 2 * a, 0, a, 0, 0, 1 - 2 * a, a];
    }
    throw new Error(`no filter ${f}`);
  }

  function lookSteps(value) {
    return LOOKS.find((l) => l.value === value).filters.map(([f, a]) => filterMatrix(f, a));
  }

  function pad(n, width = 2) {
    return String(n).padStart(width, '0');
  }

  function fileName(kind, date, ext, n) {
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
      `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `${DIR}${kind}_${stamp}${n ? `_${n}` : ''}.${ext}`;
  }

  function duration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  function room(freeBytes, mode, settings, table) {
    if (mode === 'video') {
      const p = table.video.options.find((o) => o.value === settings.video).profile;
      const seconds = freeBytes / ((p.bps + 156000) / 8);
      return seconds >= 3600 ? `${Math.floor(seconds / 3600)} h` : `${Math.floor(seconds / 60)} min`;
    }
    const size = table.photoSize.options.find((o) => o.value === settings.photoSize).size;
    const bytesPerPixel = { 90: 0.25, 95: 0.35, 100: 0.7 }[settings.quality] || 0.35;
    const n = Math.floor(freeBytes / (size.width * size.height * bytesPerPixel));
    return n >= 10000 ? `${Math.floor(n / 1000)}k` : String(n);
  }

  exports.CameraModel = {
    MODES, MODE_NAMES, modes, profiles, mmsProfile, lookCss, lookSteps, cropRect, photoSizes,
    formatEv, evSteps, choices, rows, settle, step, nudge, label, configuration, previewSize, fileName, duration,
    room,
  };
  if (typeof module !== 'undefined') {
    module.exports = exports.CameraModel;
  }
}(typeof window !== 'undefined' ? window : globalThis));

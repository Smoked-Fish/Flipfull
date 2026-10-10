'use strict';

importScripts('imaging.js', 'model.js');

const I = self.CameraImaging;
const M = self.CameraModel;
const HELPERS = Math.max(1, Math.min(4, (self.navigator.hardwareConcurrency || 2) - 2));
let shots = [];
const helpers = [];
let helperJob = 0;

async function decode(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height };
}

async function decodeRows(blob, w, top, bottom) {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(w, bottom - top);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, top, w, bottom - top, 0, 0, w, bottom - top);
  bmp.close();
  return ctx.getImageData(0, 0, w, bottom - top).data;
}

function helper(k, op, data, progress) {
  if (!helpers[k]) {
    helpers[k] = new Worker('worker.js');
  }
  const worker = helpers[k];
  const id = ++helperJob;
  return new Promise((resolve, reject) => {
    const listen = (e) => {
      if (e.data.id !== id) {
        return;
      }
      if ('progress' in e.data) {
        progress(e.data.progress);
        return;
      }
      worker.removeEventListener('message', listen);
      if (e.data.error) {
        reject(new Error(e.data.error));
      } else {
        resolve(e.data);
      }
    };
    worker.addEventListener('message', listen);
    worker.postMessage(Object.assign({ id, op }, data));
  });
}

async function encode(rgba, w, h, crop, quality, exif, look) {
  if (look && look !== 'none') {
    I.applyLook(rgba, M.lookSteps(look));
  }
  let canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  if (crop) {
    const cut = new OffscreenCanvas(crop.width, crop.height);
    cut.getContext('2d').drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    canvas = cut;
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([exif ? I.withExif(bytes, exif, canvas.width, canvas.height) : bytes], { type: 'image/jpeg' });
}

async function exifFrom(blob) {
  return I.exifOf(new Uint8Array(await blob.slice(0, 128 * 1024).arrayBuffer()));
}

function cropFor(aspect, w, h) {
  return aspect ? M.cropRect(w, h, aspect) : null;
}

const IDENTITY = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };

function fromFirst(q) {
  return shots.length ? I.align(shots[0].q, q) : IDENTITY;
}

function between(ref, s) {
  return I.compose(s.t, I.invert(ref.t));
}

const ops = {
  async shot({ blob, ev }) {
    const { rgba, w, h } = await decode(blob);
    const q = I.quarterLuma(rgba, w, h);
    shots.push({ blob, ev, q, t: fromFirst(q), sharp: I.sharpness(q), w, h });
    return {};
  },

  async night({ quality, aspect, look }, progress) {
    const ref = shots.reduce((best, s) => (s.sharp > best.sharp ? s : best), shots[0]);
    const others = shots.filter((s) => s !== ref).map((s) => ({ blob: s.blob, q: s.q, t: between(ref, s) }));
    const { w, h } = ref;
    const spread = I.mergeSpread(ref.q);
    const step = Math.ceil(h / HELPERS / 4) * 4;
    const done = new Array(HELPERS).fill(0);
    const bands = [];
    for (let k = 0; k * step < h; k++) {
      const lo = k * step;
      const hi = Math.min(h, lo + step);
      bands.push(helper(k, 'band', { ref: { blob: ref.blob, q: ref.q }, others, w, h, lo, hi, spread }, (p) => {
        done[k] = p;
        progress(done.reduce((a, b) => a + b, 0) / bands.length);
      }).then((r) => ({ lo, rows: r.rows })));
    }
    const rgba = new Uint8ClampedArray(w * h * 4);
    (await Promise.all(bands)).forEach((b) => rgba.set(b.rows, b.lo * w * 4));
    const blob = await encode(rgba, w, h, cropFor(aspect, w, h), quality, await exifFrom(ref.blob), look);
    return { blob, plain: ref.blob };
  },

  async band({ ref, others, w, h, lo, hi, spread }, progress) {
    const top = Math.max(0, lo - 1);
    const bottom = Math.min(h, hi + 1);
    const rows = await decodeRows(ref.blob, w, top, bottom);
    const merge = I.startMerge(rows, w, h, ref.q, top, bottom, spread);
    for (let k = 0; k < others.length; k++) {
      const s = others[k];
      const from = I.sourceRows(s.t, w, h, top, bottom);
      if (from.bottom - from.top > 1) {
        I.addToMerge(merge, await decodeRows(s.blob, w, from.top, from.bottom), from.top, s.q, s.t);
      }
      progress((k + 1) / others.length);
    }
    const out = I.sharpen(I.finishMerge(merge, rows), w, bottom - top, 0.4);
    return { rows: out.slice((lo - top) * w * 4, (hi - top) * w * 4) };
  },

  async hdr({ quality, aspect, look }, progress) {
    const ref = shots.find((s) => s.ev === 0) || shots[0];
    const { w, h } = ref;
    const images = [];
    for (const s of shots) {
      const frame = await decode(s.blob);
      images.push(s === ref ? frame.rgba : I.warp(frame.rgba, w, h, between(ref, s)));
    }
    progress(0.1);
    const out = I.fuse(images, w, h, (p) => progress(0.1 + 0.85 * p));
    const blob = await encode(out, w, h, cropFor(aspect, w, h), quality, await exifFrom(ref.blob), look);
    return { blob, plain: ref.blob };
  },

  async finish({ blob, quality, aspect, look }) {
    const { rgba, w, h } = await decode(blob);
    return { blob: await encode(rgba, w, h, cropFor(aspect, w, h), quality, await exifFrom(blob), look) };
  },

  async fit({ blob, maxBytes }) {
    const bmp = await createImageBitmap(blob);
    let scale = 1;
    for (let pass = 0; pass < 8; pass++) {
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      if (out.size <= maxBytes) {
        bmp.close();
        return { blob: out };
      }
      scale *= Math.sqrt(maxBytes / out.size) * 0.95;
    }
    bmp.close();
    throw new Error("the picture doesn't get small enough");
  },

  async clear() {
    shots = [];
    return {};
  },
};

self.onmessage = (e) => {
  const { id, op } = e.data;
  const finish = (result) => {
    if (op === 'night' || op === 'hdr') {
      shots = [];
    }
    self.postMessage(Object.assign({ id }, result));
  };
  ops[op](e.data, (progress) => self.postMessage({ id, progress }))
    .then(finish, (err) => finish({ error: String(err && err.message || err) }));
};

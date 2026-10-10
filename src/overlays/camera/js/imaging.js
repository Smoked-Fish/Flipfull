'use strict';

(function (exports) {
  const TILE = 32;
  const TILE_SEARCH = 4;
  const COARSE_SEARCH = 8;

  function quarterLuma(rgba, w, h) {
    const qw = w >> 2;
    const qh = h >> 2;
    const out = new Float32Array(qw * qh);
    for (let y = 0; y < qh * 4; y++) {
      const row = (y >> 2) * qw;
      let i = y * w * 4;
      for (let qx = 0; qx < qw; qx++) {
        let s = 0;
        for (let k = 0; k < 4; k++, i += 4) {
          s += 77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2];
        }
        out[row + qx] += s;
      }
    }
    for (let k = 0; k < out.length; k++) {
      out[k] /= 16 * 256;
    }
    return { data: out, width: qw, height: qh };
  }

  function half(img) {
    const w = img.width >> 1;
    const h = img.height >> 1;
    const src = img.data;
    const sw = img.width;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = 2 * y * sw + 2 * x;
        out[y * w + x] = (src[i] + src[i + 1] + src[i + sw] + src[i + sw + 1]) / 4;
      }
    }
    return { data: out, width: w, height: h };
  }

  function sharpness(img) {
    const { data, width: w, height: h } = img;
    let s = 0;
    for (let y = 1; y < h; y++) {
      for (let x = 1; x < w; x++) {
        const i = y * w + x;
        const dx = data[i] - data[i - 1];
        const dy = data[i] - data[i - w];
        s += dx * dx + dy * dy;
      }
    }
    return s / ((w - 1) * (h - 1));
  }

  function ncc(a, b, ax, ay, bx, by, n, m) {
    const aw = a.width;
    const bw = b.width;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let y = 0; y < m; y++) {
      let i = (ay + y) * aw + ax;
      let j = (by + y) * bw + bx;
      for (let x = 0; x < n; x++, i++, j++) {
        const va = a.data[i];
        const vb = b.data[j];
        sa += va;
        sb += vb;
        saa += va * va;
        sbb += vb * vb;
        sab += va * vb;
      }
    }
    const k = n * m;
    const va = saa - sa * sa / k;
    const vb = sbb - sb * sb / k;
    return va > 1e-9 && vb > 1e-9 ? (sab - sa * sb / k) / Math.sqrt(va * vb) : -1;
  }

  function coarseShift(a, b, range, from) {
    const mx = range + Math.abs(from.x) + Math.floor(a.width * 0.1);
    const my = range + Math.abs(from.y) + Math.floor(a.height * 0.1);
    const n = a.width - 2 * mx;
    const m = a.height - 2 * my;
    let best = { x: from.x, y: from.y, score: -2 };
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        const score = ncc(a, b, mx, my, mx + from.x + dx, my + from.y + dy, n, m);
        if (score > best.score) {
          best = { x: from.x + dx, y: from.y + dy, score };
        }
      }
    }
    return best;
  }

  function vertex(l, c, r) {
    const d = l - 2 * c + r;
    return d < 0 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d))) : 0;
  }

  function variance(img, x0, y0, n) {
    let s = 0;
    let ss = 0;
    for (let y = y0; y < y0 + n; y++) {
      for (let x = x0; x < x0 + n; x++) {
        const v = img.data[y * img.width + x];
        s += v;
        ss += v * v;
      }
    }
    const k = n * n;
    return ss / k - (s / k) * (s / k);
  }

  function tileMatches(ref, img, shift) {
    const out = [];
    const margin = TILE_SEARCH + Math.max(Math.abs(shift.x), Math.abs(shift.y));
    for (let ty = margin; ty + TILE + margin <= ref.height; ty += TILE) {
      for (let tx = margin; tx + TILE + margin <= ref.width; tx += TILE) {
        if (variance(ref, tx, ty, TILE) < 2) {
          continue;
        }
        const size = 2 * TILE_SEARCH + 1;
        const scores = new Float32Array(size * size);
        let best = -1;
        let bi = 0;
        for (let dy = -TILE_SEARCH; dy <= TILE_SEARCH; dy++) {
          for (let dx = -TILE_SEARCH; dx <= TILE_SEARCH; dx++) {
            const k = (dy + TILE_SEARCH) * size + dx + TILE_SEARCH;
            scores[k] = ncc(ref, img, tx, ty, tx + shift.x + dx, ty + shift.y + dy, TILE, TILE);
            if (scores[k] > best) {
              best = scores[k];
              bi = k;
            }
          }
        }
        const bx = bi % size;
        const by = (bi / size) | 0;
        if (best < 0.8 || bx === 0 || by === 0 || bx === size - 1 || by === size - 1) {
          continue;
        }
        const sx = vertex(scores[bi - 1], best, scores[bi + 1]);
        const sy = vertex(scores[bi - size], best, scores[bi + size]);
        out.push({
          x: tx + TILE / 2, y: ty + TILE / 2,
          u: tx + TILE / 2 + shift.x + bx - TILE_SEARCH + sx,
          v: ty + TILE / 2 + shift.y + by - TILE_SEARCH + sy,
          weight: best,
        });
      }
    }
    return out;
  }

  function solve3(m, r) {
    const det = (a) => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) +
      a[2] * (a[3] * a[7] - a[4] * a[6]);
    const d = det(m);
    if (Math.abs(d) < 1e-9) {
      return null;
    }
    return [0, 1, 2].map((c) => {
      const mc = m.slice();
      for (let row = 0; row < 3; row++) {
        mc[row * 3 + c] = r[row];
      }
      return det(mc) / d;
    });
  }

  function fitAffine(points, weights) {
    const m = new Array(9).fill(0);
    const ru = [0, 0, 0];
    const rv = [0, 0, 0];
    points.forEach((p, i) => {
      const w = weights[i];
      const row = [p.x, p.y, 1];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          m[r * 3 + c] += w * row[r] * row[c];
        }
        ru[r] += w * row[r] * p.u;
        rv[r] += w * row[r] * p.v;
      }
    });
    const su = solve3(m, ru);
    const sv = solve3(m, rv);
    return su && sv ? { a: su[0], b: su[1], c: su[2], d: sv[0], e: sv[1], f: sv[2] } : null;
  }

  function translation(x, y) {
    return { a: 1, b: 0, c: x, d: 0, e: 1, f: y };
  }

  function median(values) {
    const s = values.slice().sort((p, q) => p - q);
    return s.length ? s[s.length >> 1] : 0;
  }

  function align(ref, img) {
    const ref8 = half(ref);
    const img8 = half(img);
    const rough = coarseShift(half(ref8), half(img8), COARSE_SEARCH, { x: 0, y: 0 });
    const fine = coarseShift(ref8, img8, 2, { x: rough.x * 2, y: rough.y * 2 });
    const shift = { x: fine.x * 2, y: fine.y * 2 };
    const points = tileMatches(ref, img, shift);
    if (points.length < 8) {
      return points.length ? translation(median(points.map((p) => p.u - p.x)), median(points.map((p) => p.v - p.y)))
        : translation(shift.x, shift.y);
    }
    let weights = points.map((p) => p.weight);
    let t = null;
    for (let pass = 0; pass < 4; pass++) {
      t = fitAffine(points, weights);
      if (!t) {
        break;
      }
      weights = points.map((p) => {
        const du = t.a * p.x + t.b * p.y + t.c - p.u;
        const dv = t.d * p.x + t.e * p.y + t.f - p.v;
        return p.weight / (1 + (du * du + dv * dv) / 0.25);
      });
    }
    if (!t || Math.abs(t.a - 1) > 0.03 || Math.abs(t.e - 1) > 0.03 || Math.abs(t.b) > 0.03 || Math.abs(t.d) > 0.03) {
      return translation(median(points.map((p) => p.u - p.x)), median(points.map((p) => p.v - p.y)));
    }
    return t;
  }

  function invert(t) {
    const det = t.a * t.e - t.b * t.d;
    const a = t.e / det;
    const b = -t.b / det;
    const d = -t.d / det;
    const e = t.a / det;
    return { a, b, c: -(a * t.c + b * t.f), d, e, f: -(d * t.c + e * t.f) };
  }

  function compose(outer, inner) {
    return {
      a: outer.a * inner.a + outer.b * inner.d, b: outer.a * inner.b + outer.b * inner.e,
      c: outer.a * inner.c + outer.b * inner.f + outer.c,
      d: outer.d * inner.a + outer.e * inner.d, e: outer.d * inner.b + outer.e * inner.e,
      f: outer.d * inner.c + outer.e * inner.f + outer.f,
    };
  }

  function toFull(t) {
    return {
      a: t.a, b: t.b, c: 4 * t.c + 1.5 * (1 - t.a - t.b),
      d: t.d, e: t.e, f: 4 * t.f + 1.5 * (1 - t.d - t.e),
    };
  }

  function noise(img) {
    const { data, width: w, height: h } = img;
    const diffs = [];
    for (let y = 1; y < h - 1; y += 3) {
      for (let x = 1; x < w - 1; x += 3) {
        const i = y * w + x;
        diffs.push(Math.abs(data[i] - (data[i - 1] + data[i + 1]) / 2));
      }
    }
    return Math.max(0.5, 1.4826 * median(diffs) / Math.sqrt(1.5));
  }

  function sampleLuma(img, x, y) {
    const w = img.width;
    if (x < 0 || y < 0 || x > w - 1.001 || y > img.height - 1.001) {
      return -1;
    }
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * w + x0;
    const d = img.data;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
  }

  function mergeSpread(refQ) {
    return 3 * Math.SQRT2 * noise(refQ);
  }

  function startMerge(ref, w, h, refQ, lo = 0, hi = h, spread = mergeSpread(refQ)) {
    const sum = new Float32Array(w * (hi - lo) * 3);
    for (let i = 0, j = 0; i < sum.length / 3; i++, j += 4) {
      sum[i * 3] = ref[j];
      sum[i * 3 + 1] = ref[j + 1];
      sum[i * 3 + 2] = ref[j + 2];
    }
    const weight = new Float32Array(refQ.width * refQ.height).fill(1);
    return { w, h, lo, hi, sum, weight, refQ, spread };
  }

  function sourceRows(t, w, h, lo, hi) {
    const f = toFull(t);
    const ys = [[0, lo], [w, lo], [0, hi], [w, hi]].map(([x, y]) => f.d * x + f.e * y + f.f);
    return {
      top: Math.max(0, Math.min(h, Math.floor(Math.min(...ys)) - 2)),
      bottom: Math.max(0, Math.min(h, Math.ceil(Math.max(...ys)) + 3)),
    };
  }

  function addToMerge(m, rgba, top, frameQ, t) {
    const { w, h, lo, hi, sum, weight, refQ } = m;
    const bottom = top + rgba.length / (4 * w);
    const qw = refQ.width;
    const qh = refQ.height;
    const wq = new Float32Array(qw * qh);
    let sumRef = 0;
    let sumFrame = 0;
    for (let y = 0; y < qh; y++) {
      for (let x = 0; x < qw; x++) {
        const v = sampleLuma(frameQ, t.a * x + t.b * y + t.c, t.d * x + t.e * y + t.f);
        wq[y * qw + x] = v;
        if (v >= 0) {
          sumRef += refQ.data[y * qw + x];
          sumFrame += v;
        }
      }
    }
    const gain = sumFrame > 0 ? Math.max(0.8, Math.min(1.25, sumRef / sumFrame)) : 1;
    for (let i = 0; i < wq.length; i++) {
      if (wq[i] < 0) {
        wq[i] = 0;
      } else {
        const d = (wq[i] * gain - refQ.data[i]) / m.spread;
        wq[i] = 1 / (1 + d * d);
      }
    }
    const f = toFull(t);
    const last = Math.min(h, bottom) - 1;
    for (let y = lo; y < hi; y++) {
      const qrow = Math.min(qh - 1, y >> 2) * qw;
      let sx = f.b * y + f.c;
      let sy = f.e * y + f.f;
      for (let x = 0; x < w; x++, sx += f.a, sy += f.d) {
        const k = wq[qrow + Math.min(qw - 1, x >> 2)];
        if (k === 0 || sx < 0 || sy < top || sx >= w - 1 || sy >= last) {
          continue;
        }
        const x0 = sx | 0;
        const y0 = sy | 0;
        const fx = sx - x0;
        const fy = sy - y0;
        const kg = k * gain;
        const w00 = (1 - fx) * (1 - fy) * kg;
        const w01 = fx * (1 - fy) * kg;
        const w10 = (1 - fx) * fy * kg;
        const w11 = fx * fy * kg;
        const i = ((y0 - top) * w + x0) * 4;
        const j = i + w * 4;
        const o = ((y - lo) * w + x) * 3;
        sum[o] += rgba[i] * w00 + rgba[i + 4] * w01 + rgba[j] * w10 + rgba[j + 4] * w11;
        sum[o + 1] += rgba[i + 1] * w00 + rgba[i + 5] * w01 + rgba[j + 1] * w10 + rgba[j + 5] * w11;
        sum[o + 2] += rgba[i + 2] * w00 + rgba[i + 6] * w01 + rgba[j + 2] * w10 + rgba[j + 6] * w11;
      }
    }
    for (let i = 0; i < wq.length; i++) {
      weight[i] += wq[i];
    }
  }

  function finishMerge(m, out) {
    const { w, lo, hi, sum, weight, refQ } = m;
    const qw = refQ.width;
    for (let y = lo; y < hi; y++) {
      const qrow = Math.min(refQ.height - 1, y >> 2) * qw;
      for (let x = 0; x < w; x++) {
        const k = 1 / weight[qrow + Math.min(qw - 1, x >> 2)];
        const o = ((y - lo) * w + x) * 3;
        const i = o / 3 * 4;
        out[i] = sum[o] * k;
        out[i + 1] = sum[o + 1] * k;
        out[i + 2] = sum[o + 2] * k;
        out[i + 3] = 255;
      }
    }
    return out;
  }

  function box3(src, w, h) {
    const rows = new Float32Array(w * h);
    for (let r = 0; r < h; r++) {
      const o = r * w;
      for (let x = 0; x < w; x++) {
        rows[o + x] = src[o + (x > 0 ? x - 1 : x)] + src[o + x] + src[o + (x < w - 1 ? x + 1 : x)];
      }
    }
    const out = new Float32Array(w * h);
    for (let r = 0; r < h; r++) {
      const up = (r > 0 ? r - 1 : r) * w;
      const dn = (r < h - 1 ? r + 1 : r) * w;
      const o = r * w;
      for (let x = 0; x < w; x++) {
        out[o + x] = (rows[up + x] + rows[o + x] + rows[dn + x]) / 9;
      }
    }
    return out;
  }

  function sharpen(rgba, w, h, amount) {
    const y = new Float32Array(w * h);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      y[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    }
    const blurred = box3(y, w, h);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const detail = amount * (y[i] - blurred[i]);
      rgba[j] += detail;
      rgba[j + 1] += detail;
      rgba[j + 2] += detail;
    }
    return rgba;
  }

  function applyLook(rgba, steps) {
    for (let j = 0; j < rgba.length; j += 4) {
      let r = rgba[j] / 255;
      let g = rgba[j + 1] / 255;
      let b = rgba[j + 2] / 255;
      for (const m of steps) {
        const r2 = m[0] * r + m[1] * g + m[2] * b + m[3];
        const g2 = m[4] * r + m[5] * g + m[6] * b + m[7];
        const b2 = m[8] * r + m[9] * g + m[10] * b + m[11];
        r = r2 < 0 ? 0 : r2 > 1 ? 1 : r2;
        g = g2 < 0 ? 0 : g2 > 1 ? 1 : g2;
        b = b2 < 0 ? 0 : b2 > 1 ? 1 : b2;
      }
      rgba[j] = r * 255;
      rgba[j + 1] = g * 255;
      rgba[j + 2] = b * 255;
    }
    return rgba;
  }

  function warp(rgba, w, h, t) {
    const out = new Uint8ClampedArray(w * h * 4);
    const f = toFull(t);
    for (let y = 0; y < h; y++) {
      let sx = f.b * y + f.c;
      let sy = f.e * y + f.f;
      for (let x = 0; x < w; x++, sx += f.a, sy += f.d) {
        if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) {
          continue;
        }
        const x0 = sx | 0;
        const y0 = sy | 0;
        const fx = sx - x0;
        const fy = sy - y0;
        const i = (y0 * w + x0) * 4;
        const j = i + w * 4;
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          out[o + c] = (rgba[i + c] * (1 - fx) + rgba[i + 4 + c] * fx) * (1 - fy) +
            (rgba[j + c] * (1 - fx) + rgba[j + 4 + c] * fx) * fy;
        }
        out[o + 3] = 255;
      }
    }
    return out;
  }

  function down(src, w, h) {
    const w2 = (w + 1) >> 1;
    const h2 = (h + 1) >> 1;
    const tmp = new Float32Array(w2 * h);
    const edge = (o, c) => (src[o + Math.max(0, c - 2)] + 4 * src[o + Math.max(0, c - 1)] + 6 * src[o + c] +
      4 * src[o + Math.min(w - 1, c + 1)] + src[o + Math.min(w - 1, c + 2)]) * 0.0625;
    const inner = Math.max(1, (w - 3) >> 1);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      const t = y * w2;
      tmp[t] = edge(o, 0);
      for (let x = 1; x < inner; x++) {
        const i = o + 2 * x;
        tmp[t + x] = (src[i - 2] + src[i + 2] + 4 * (src[i - 1] + src[i + 1]) + 6 * src[i]) * 0.0625;
      }
      for (let x = inner; x < w2; x++) {
        tmp[t + x] = edge(o, 2 * x);
      }
    }
    const out = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      const c = 2 * y;
      const r0 = Math.max(0, c - 2) * w2;
      const r1 = Math.max(0, c - 1) * w2;
      const r2 = c * w2;
      const r3 = Math.min(h - 1, c + 1) * w2;
      const r4 = Math.min(h - 1, c + 2) * w2;
      const o = y * w2;
      for (let x = 0; x < w2; x++) {
        out[o + x] = (tmp[r0 + x] + tmp[r4 + x] + 4 * (tmp[r1 + x] + tmp[r3 + x]) + 6 * tmp[r2 + x]) * 0.0625;
      }
    }
    return out;
  }

  function up(src, sw, sh, w, h) {
    const tmp = new Float32Array(w * sh);
    for (let y = 0; y < sh; y++) {
      const o = y * sw;
      const t = y * w;
      for (let i = 0; i < sw; i++) {
        const l = src[o + Math.max(0, i - 1)];
        const c = src[o + i];
        const r = src[o + Math.min(sw - 1, i + 1)];
        tmp[t + 2 * i] = (l + 6 * c + r) * 0.125;
        if (2 * i + 1 < w) {
          tmp[t + 2 * i + 1] = (c + r) * 0.5;
        }
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const i = y >> 1;
      const b = i * w;
      const c = Math.min(sh - 1, i + 1) * w;
      const o = y * w;
      if (y & 1) {
        for (let x = 0; x < w; x++) {
          out[o + x] = (tmp[b + x] + tmp[c + x]) * 0.5;
        }
      } else {
        const a = Math.max(0, i - 1) * w;
        for (let x = 0; x < w; x++) {
          out[o + x] = (tmp[a + x] + 6 * tmp[b + x] + tmp[c + x]) * 0.125;
        }
      }
    }
    return out;
  }

  function levelsFor(w, h) {
    return Math.max(1, Math.floor(Math.log2(Math.min(w, h))) - 3);
  }

  function gaussianPyramid(level0, w, h, levels) {
    const out = [{ data: level0, w, h }];
    for (let k = 1; k < levels; k++) {
      const p = out[k - 1];
      out.push({ data: down(p.data, p.w, p.h), w: (p.w + 1) >> 1, h: (p.h + 1) >> 1 });
    }
    return out;
  }

  const EXPOSED = Float32Array.from({ length: 256 }, (_, v) => Math.exp(-((v / 255 - 0.5) ** 2) / 0.08));

  function fusionWeight(rgba, w, h) {
    const out = new Float32Array(w * h);
    const luma = new Float32Array(w * h);
    const sat = new Float32Array(w * h);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const cr = rgba[j];
      const cg = rgba[j + 1];
      const cb = rgba[j + 2];
      const mean = (cr + cg + cb) / 3;
      luma[i] = (0.299 * cr + 0.587 * cg + 0.114 * cb) / 255;
      sat[i] = Math.sqrt(((cr - mean) ** 2 + (cg - mean) ** 2 + (cb - mean) ** 2) / 3) / 255;
    }
    const y = box3(luma, w, h);
    const saturation = box3(sat, w, h);
    for (let r = 0; r < h; r++) {
      const up = (r > 0 ? r - 1 : 0) * w;
      const dn = (r < h - 1 ? r + 1 : r) * w;
      const o = r * w;
      for (let x = 0; x < w; x++) {
        const i = o + x;
        const j = i * 4;
        if (rgba[j + 3] === 0) {
          continue;
        }
        const left = x > 0 ? y[i - 1] : y[i];
        const right = x < w - 1 ? y[i + 1] : y[i];
        const contrast = Math.abs(4 * y[i] - left - right - y[up + x] - y[dn + x]);
        out[i] = (contrast + 0.02) * (saturation[i] + 0.02) * EXPOSED[rgba[j]] * EXPOSED[rgba[j + 1]] *
          EXPOSED[rgba[j + 2]] + 1e-6;
      }
    }
    return out;
  }

  function laplacian(level0, w, h, levels) {
    const pyr = gaussianPyramid(level0, w, h, levels);
    for (let k = 0; k < levels - 1; k++) {
      const upper = up(pyr[k + 1].data, pyr[k + 1].w, pyr[k + 1].h, pyr[k].w, pyr[k].h);
      const d = pyr[k].data;
      for (let i = 0; i < d.length; i++) {
        d[i] -= upper[i];
      }
    }
    return pyr;
  }

  function blendInto(result, lap, g, from) {
    if (!result.length) {
      lap.forEach((p) => result.push({ data: new Float32Array(p.data.length), w: p.w, h: p.h }));
    }
    for (let k = 0; k < result.length; k++) {
      const r = result[k].data;
      const d = lap[k].data;
      const gw = g[k + from].data;
      for (let i = 0; i < r.length; i++) {
        r[i] += d[i] * gw[i];
      }
    }
  }

  function collapse(pyr) {
    let img = pyr[pyr.length - 1].data;
    for (let k = pyr.length - 2; k >= 0; k--) {
      const upper = up(img, pyr[k + 1].w, pyr[k + 1].h, pyr[k].w, pyr[k].h);
      const d = pyr[k].data;
      for (let i = 0; i < d.length; i++) {
        upper[i] += d[i];
      }
      img = upper;
    }
    return img;
  }

  function fuse(images, w, h, progress) {
    const weights = images.map((rgba) => fusionWeight(rgba, w, h));
    const total = new Float32Array(w * h);
    weights.forEach((wt) => {
      for (let i = 0; i < total.length; i++) {
        total[i] += wt[i];
      }
    });
    weights.forEach((wt) => {
      for (let i = 0; i < total.length; i++) {
        wt[i] /= total[i];
      }
    });
    const levels = levelsFor(w, h);
    const luma = [];
    const red = [];
    const blue = [];
    images.forEach((rgba, n) => {
      const g = gaussianPyramid(weights[n], w, h, levels);
      weights[n] = null;
      const y = new Float32Array(w * h);
      const cr = new Float32Array(w * h);
      const cb = new Float32Array(w * h);
      for (let i = 0, j = 0; i < w * h; i++, j += 4) {
        y[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
        cr[i] = rgba[j] - y[i];
        cb[i] = rgba[j + 2] - y[i];
      }
      blendInto(luma, laplacian(y, w, h, levels), g, 0);
      blendInto(red, laplacian(down(cr, w, h), g[1].w, g[1].h, levels - 1), g, 1);
      blendInto(blue, laplacian(down(cb, w, h), g[1].w, g[1].h, levels - 1), g, 1);
      if (progress) {
        progress((n + 1) / images.length);
      }
    });
    const y = collapse(luma);
    const cr = up(box3(collapse(red), red[0].w, red[0].h), red[0].w, red[0].h, w, h);
    const cb = up(box3(collapse(blue), blue[0].w, blue[0].h), blue[0].w, blue[0].h, w, h);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const r = y[i] + cr[i];
      const b = y[i] + cb[i];
      out[j] = r;
      out[j + 1] = (y[i] - 0.299 * r - 0.114 * b) / 0.587;
      out[j + 2] = b;
      out[j + 3] = 255;
    }
    return out;
  }

  function u16(b, o, le) {
    return le ? b[o] | b[o + 1] << 8 : b[o] << 8 | b[o + 1];
  }

  function u32(b, o, le) {
    return (le ? b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24
      : b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
  }

  function put16(b, o, v, le) {
    b[o + (le ? 0 : 1)] = v & 255;
    b[o + (le ? 1 : 0)] = v >> 8 & 255;
  }

  function put32(b, o, v, le) {
    for (let k = 0; k < 4; k++) {
      b[o + (le ? k : 3 - k)] = v >>> (8 * k) & 255;
    }
  }

  function segments(jpeg) {
    const out = [];
    let i = 2;
    while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
      const marker = jpeg[i + 1];
      if (marker === 0xda) {
        break;
      }
      const end = i + 2 + (jpeg[i + 2] << 8 | jpeg[i + 3]);
      out.push({ marker, start: i, end });
      i = end;
    }
    return out;
  }

  function exifOf(jpeg) {
    const s = segments(jpeg).find((g) => g.marker === 0xe1 &&
      String.fromCharCode(...jpeg.subarray(g.start + 4, g.start + 8)) === 'Exif');
    return s ? jpeg.slice(s.start, s.end) : null;
  }

  function entries(b, t, o, le) {
    const n = u16(b, t + o, le);
    const out = [];
    for (let k = 0; k < n; k++) {
      const e = t + o + 2 + k * 12;
      out.push({ tag: u16(b, e, le), type: u16(b, e + 2, le), at: e + 8 });
    }
    return { list: out, next: t + o + 2 + n * 12 };
  }

  function setNumber(b, entry, v, le) {
    if (entry.type === 3) {
      put16(b, entry.at, v, le);
    } else if (entry.type === 4) {
      put32(b, entry.at, v, le);
    }
  }

  function withExif(jpeg, exif, width, height) {
    const b = exif.slice();
    const t = 10;
    const le = b[t] === 0x49;
    const ifd0 = entries(b, t, u32(b, t + 4, le), le);
    ifd0.list.forEach((e) => {
      if (e.tag === 0x100) setNumber(b, e, width, le);
      if (e.tag === 0x101) setNumber(b, e, height, le);
      if (e.tag === 0x112) setNumber(b, e, 1, le);
      if (e.tag === 0x8769) {
        entries(b, t, u32(b, e.at, le), le).list.forEach((x) => {
          if (x.tag === 0xa002) setNumber(b, x, width, le);
          if (x.tag === 0xa003) setNumber(b, x, height, le);
        });
      }
    });
    put32(b, ifd0.next, 0, le);
    const keep = segments(jpeg).filter((g) => g.marker !== 0xe0 && g.marker !== 0xe1);
    const rest = segments(jpeg).reduce((end, g) => Math.max(end, g.end), 2);
    const parts = [jpeg.subarray(0, 2), b, ...keep.map((g) => jpeg.subarray(g.start, g.end)), jpeg.subarray(rest)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    parts.forEach((p) => {
      out.set(p, o);
      o += p.length;
    });
    return out;
  }

  exports.CameraImaging = {
    quarterLuma, sharpness, align, invert, compose, toFull, mergeSpread, startMerge, sourceRows, addToMerge, finishMerge, sharpen, applyLook, warp, fuse, exifOf,
    withExif, segments,
  };
  if (typeof module !== 'undefined') {
    module.exports = exports.CameraImaging;
  }
}(typeof self !== 'undefined' ? self : globalThis));

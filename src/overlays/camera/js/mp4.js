'use strict';

(function (exports) {
  const CONTAINERS = ['moov', 'trak', 'edts', 'mdia', 'minf', 'stbl'];
  const TABLES = ['stsd', 'stts', 'stss', 'stsz', 'stsc', 'stco', 'co64'];

  const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourcc = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const total = (runs) => runs.reduce((n, [count, each]) => n + count * each, 0);

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    parts.forEach((p) => {
      out.set(p, at);
      at += p.length;
    });
    return out;
  }

  function parse(bytes) {
    const dv = view(bytes);
    const out = [];
    for (let at = 0; at < bytes.length;) {
      const size = dv.getUint32(at);
      if (size < 8 || at + size > bytes.length) {
        throw new Error('a broken box');
      }
      const type = fourcc(bytes, at + 4);
      const body = bytes.subarray(at + 8, at + size);
      out.push(CONTAINERS.includes(type) ? { type, kids: parse(body) } : { type, body });
      at += size;
    }
    return out;
  }

  function write(b) {
    const body = b.kids ? concat(b.kids.map(write)) : b.body;
    const head = new Uint8Array(8);
    view(head).setUint32(0, 8 + body.length);
    head.set(Array.from(b.type, (c) => c.charCodeAt(0)), 4);
    return concat([head, body]);
  }

  function child(b, type) {
    return b.kids.find((k) => k.type === type);
  }

  function v0(body) {
    if (body[0] !== 0) {
      throw new Error('a 64-bit header');
    }
    return view(body);
  }

  function withU32(body, at, value) {
    const out = body.slice();
    view(out).setUint32(at, value);
    return out;
  }

  function table(body, per) {
    const dv = view(body);
    const out = [];
    for (let i = 0, n = dv.getUint32(4); i < n; i++) {
      const e = [];
      for (let j = 0; j < per; j++) {
        e.push(dv.getUint32(8 + 4 * (per * i + j)));
      }
      out.push(per === 1 ? e[0] : e);
    }
    return out;
  }

  function full32(numbers) {
    const body = new Uint8Array(4 + 4 * numbers.length);
    const dv = view(body);
    numbers.forEach((n, i) => dv.setUint32(4 + 4 * i, n));
    return body;
  }

  function co64(offsets) {
    const body = new Uint8Array(8 + 8 * offsets.length);
    const dv = view(body);
    dv.setUint32(4, offsets.length);
    offsets.forEach((o, i) => dv.setBigUint64(8 + 8 * i, BigInt(o)));
    return body;
  }

  function elst(edits) {
    const body = new Uint8Array(8 + 12 * edits.length);
    const dv = view(body);
    dv.setUint32(4, edits.length);
    edits.forEach(([duration, from], i) => {
      dv.setUint32(8 + 12 * i, duration);
      dv.setInt32(12 + 12 * i, from);
      dv.setUint16(16 + 12 * i, 1);
    });
    return body;
  }

  function waiting(edts) {
    if (!edts) {
      return 0;
    }
    const dv = v0(child(edts, 'elst').body);
    const n = dv.getUint32(4);
    let wait = 0;
    for (let i = 0; i < n; i++) {
      const duration = dv.getUint32(8 + 12 * i);
      const from = dv.getInt32(12 + 12 * i);
      if (i < n - 1 && from === -1) {
        wait += duration;
      } else if (i < n - 1 || from !== 0) {
        throw new Error('an edit list that cuts the track');
      }
    }
    return wait;
  }

  function track(trak, movieScale) {
    const mdia = child(trak, 'mdia');
    const stbl = child(child(mdia, 'minf'), 'stbl');
    const other = stbl.kids.find((b) => !TABLES.includes(b.type));
    if (other) {
      throw new Error(`no joining ${other.type}`);
    }
    v0(child(trak, 'tkhd').body);
    const body = (type) => (child(stbl, type) || {}).body;
    const stsz = view(body('stsz'));
    const fixed = stsz.getUint32(4);
    const stss = body('stss');
    const wide = body('co64');
    return {
      scale: v0(child(mdia, 'mdhd').body).getUint32(12),
      lead: waiting(child(trak, 'edts')) / movieScale,
      stsd: body('stsd'),
      runs: table(body('stts'), 2),
      sync: stss ? table(stss, 1) : null,
      sizes: Array.from({ length: stsz.getUint32(8) }, (_, i) => fixed || stsz.getUint32(12 + 4 * i)),
      chunks: table(body('stsc'), 3),
      offsets: wide ? Array.from({ length: view(wide).getUint32(4) }, (_, i) => Number(view(wide).getBigUint64(8 + 8 * i)))
        : table(body('stco'), 1),
    };
  }

  async function outline(blob) {
    const out = [];
    for (let at = 0; at < blob.size;) {
      const head = new Uint8Array(await blob.slice(at, at + 16).arrayBuffer());
      const dv = view(head);
      let size = dv.getUint32(0);
      let data = at + 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(8));
        data = at + 16;
      } else if (size === 0) {
        size = blob.size - at;
      }
      if (at + size < data) {
        throw new Error('a broken box');
      }
      out.push({ type: fourcc(head, 4), start: at, data, end: at + size });
      at += size;
    }
    return out;
  }

  async function read(blob) {
    const top = await outline(blob);
    const one = (type) => {
      const found = top.filter((b) => b.type === type);
      if (found.length !== 1) {
        throw new Error(`${found.length} ${type} boxes`);
      }
      return found[0];
    };
    const bytes = async (b) => new Uint8Array(await blob.slice(b.start, b.end).arrayBuffer());
    const moov = parse(await bytes(one('moov')))[0];
    const mvhd = v0(child(moov, 'mvhd').body);
    const scale = mvhd.getUint32(12);
    return {
      blob, ftyp: await bytes(one('ftyp')), mdat: one('mdat'), moov, scale,
      span: mvhd.getUint32(16) / scale,
      tracks: moov.kids.filter((b) => b.type === 'trak').map((trak) => track(trak, scale)),
    };
  }

  function same(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }

  function joinTrack(trak, each, parts, starts, shifts, movieScale) {
    const [first] = each;
    if (each.some((tr) => !same(tr.stsd, first.stsd))) {
      throw new Error('the parts were recorded differently');
    }
    const at = starts.map((s, k) => Math.round((s + each[k].lead - first.lead) * first.scale));
    const hasSync = each.some((tr) => tr.sync);
    let runs = [];
    let sync = [];
    let sizes = [];
    let chunks = [];
    let offsets = [];
    each.forEach((tr, k) => {
      const r = tr.runs.map((e) => e.slice());
      if (k < each.length - 1) {
        const last = r[r.length - 1];
        const before = total(r) - last[1];
        last[0]--;
        r.push([1, at[k + 1] - at[k] - before]);
      }
      if (hasSync) {
        sync = sync.concat((tr.sync || tr.sizes.map((_, i) => i + 1)).map((s) => s + sizes.length));
      }
      runs = runs.concat(r.filter(([count]) => count));
      sizes = sizes.concat(tr.sizes);
      chunks = chunks.concat(tr.chunks.map(([c, n, d]) => [c + offsets.length, n, d]));
      const { data, end } = parts[k].mdat;
      if (tr.offsets.some((o) => o < data || o >= end)) {
        throw new Error('media outside the mdat');
      }
      offsets = offsets.concat(tr.offsets.map((o) => o + shifts[k]));
    });
    const media = at[at.length - 1] + total(each[each.length - 1].runs);
    const wait = Math.round(first.lead * movieScale);
    const shown = Math.round(media / first.scale * movieScale);

    const mdia = child(trak, 'mdia');
    const mdhd = child(mdia, 'mdhd');
    mdhd.body = withU32(mdhd.body, 16, media);
    const tkhd = child(trak, 'tkhd');
    tkhd.body = withU32(tkhd.body, 20, wait + shown);
    const edts = child(trak, 'edts');
    if (edts) {
      edts.kids = [{ type: 'elst', body: elst(wait ? [[wait, -1], [shown, 0]] : [[shown, 0]]) }];
    }
    const stbl = child(child(mdia, 'minf'), 'stbl');
    stbl.kids = [
      { type: 'stsd', body: first.stsd },
      { type: 'stts', body: full32([runs.length].concat(runs.flat())) },
      ...(hasSync ? [{ type: 'stss', body: full32([sync.length].concat(sync)) }] : []),
      { type: 'stsz', body: full32([0, sizes.length].concat(sizes)) },
      { type: 'stsc', body: full32([chunks.length].concat(chunks.flat())) },
      { type: 'co64', body: co64(offsets) },
    ];
    return wait + shown;
  }

  async function join(blobs) {
    const parts = await Promise.all(blobs.map(read));
    const [first] = parts;
    if (parts.some((p) => p.tracks.length !== first.tracks.length)) {
      throw new Error('the parts were recorded differently');
    }
    const starts = [];
    const shifts = [];
    let at = first.ftyp.length + 16;
    let t = 0;
    parts.forEach((p) => {
      starts.push(t);
      shifts.push(at - p.mdat.data);
      at += p.mdat.end - p.mdat.data;
      t += p.span;
    });
    const traks = first.moov.kids.filter((b) => b.type === 'trak');
    const lengths = traks.map((trak, i) => joinTrack(trak, parts.map((p) => p.tracks[i]), parts, starts, shifts,
      first.scale));
    const mvhd = child(first.moov, 'mvhd');
    mvhd.body = withU32(mvhd.body, 16, Math.max(...lengths));

    const head = new Uint8Array(16);
    view(head).setUint32(0, 1);
    head.set([0x6d, 0x64, 0x61, 0x74], 4);
    view(head).setBigUint64(8, BigInt(at - first.ftyp.length));
    const media = parts.map((p) => p.blob.slice(p.mdat.data, p.mdat.end));
    return new Blob([first.ftyp, head, ...media, write(first.moov)], { type: first.blob.type });
  }

  exports.CameraMp4 = { read, join };
  if (typeof module !== 'undefined') {
    module.exports = exports.CameraMp4;
  }
}(typeof window !== 'undefined' ? window : globalThis));

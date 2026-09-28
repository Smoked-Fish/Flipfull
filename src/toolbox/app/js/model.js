'use strict';

(function (exports) {
  function parseIni(text) {
    const list = [];
    let current = null;
    text.split('\n').forEach((raw) => {
      const line = raw.trim();
      if (!line || line[0] === '#' || line[0] === ';') {
        return;
      }
      const head = /^\[([^\]]+)\]/.exec(line);
      if (head) {
        current = { id: head[1] };
        list.push(current);
        return;
      }
      const eq = line.indexOf('=');
      if (current && eq > 0) {
        current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    });
    let section = '';
    list.forEach((f) => {
      section = f.section || section;
      f.section = section;
    });
    return list;
  }

  function parseState(text) {
    const state = { features: {} };
    text.split('\n').forEach((line) => {
      const f = line.replace(/\r$/, '').split('\t');
      switch (f[0]) {
        case 'version': state.version = f[1]; break;
        case 'hook': state.hook = f[1] === 'yes'; break;
        case 'removable': state.removablePending = f[1] === 'pending'; break;
        case 'google-client': state.googleClient = f[1] === '-' ? '' : f[1]; break;
        case 'reboot': state.reboot = f[1] === 'yes'; break;
        case 'feature':
          state.features[f[1]] = {
            on: f[2] === 'on',
            boot: f[3],
            pending: f[4] === 'yes',
            usable: f[5],
            reason: f.slice(6).join('\t'),
          };
          break;
      }
    });
    return state;
  }

  function parseRemovable(text) {
    return text.split('\n').filter((line) => line.startsWith('app\t')).map((line) => {
      const f = line.replace(/\r$/, '').split('\t');
      return {
        name: f[1],
        removable: f[2] === '1',
        chosen: f[3] === '1',
        title: f[4] || f[1],
        core: f[5] || '',
      };
    }).sort((a, b) => a.title.localeCompare(b.title));
  }

  function parseSet(text) {
    const out = { also: [], errors: [] };
    text.split('\n').forEach((line) => {
      const also = /^also (\S+) (on|off)$/.exec(line.trim());
      if (also) {
        out.also.push({ id: also[1], on: also[2] === 'on' });
      } else if (/^error: /.test(line)) {
        out.errors.push(line.slice('error: '.length).trim());
      }
    });
    return out;
  }

  function sections(features, state) {
    const out = [];
    features.forEach((f) => {
      const s = state.features[f.id];
      if (!s) {
        return;
      }
      let group = out[out.length - 1];
      if (!group || group.name !== f.section) {
        group = { name: f.section, items: [] };
        out.push(group);
      }
      group.items.push(Object.assign({}, f, s));
    });
    return out;
  }

  function statusText(item) {
    if (item.usable === 'no') {
      return `Can't work on this phone: ${item.reason}`;
    }
    if (item.pending) {
      return item.on ? 'On after a reboot' : 'Off after a reboot';
    }
    if (item.usable === 'partly') {
      return `Partly works here: ${item.reason}`;
    }
    return '';
  }

  exports.FlipfullModel = { parseIni, parseState, parseRemovable, parseSet, sections, statusText };
  if (typeof module !== 'undefined') {
    module.exports = exports.FlipfullModel;
  }
}(typeof window !== 'undefined' ? window : globalThis));

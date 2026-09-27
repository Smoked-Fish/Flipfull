'use strict';

(function (exports) {
  function fields(body) {
    const out = {};
    let key = '';
    let val = '';
    let inKey = true;
    let escaped = false;
    const put = () => {
      const k = key.trim().toUpperCase();
      if (!k) {
        return;
      }
      if (out[k] === undefined) {
        out[k] = val;
      }
      (out[`${k}s`] = out[`${k}s`] || []).push(val);
    };
    for (const ch of body) {
      if (escaped) {
        if (inKey) key += ch; else val += ch;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (inKey && ch === ':') {
        inKey = false;
      } else if (!inKey && ch === ';') {
        put();
        key = '';
        val = '';
        inKey = true;
      } else if (inKey) {
        key += ch;
      } else {
        val += ch;
      }
    }
    if (!inKey) {
      put();
    }
    return out;
  }

  function query(qs) {
    const out = {};
    (qs || '').split('&').forEach((pair) => {
      const i = pair.indexOf('=');
      if (i > 0) {
        try {
          out[pair.slice(0, i).toLowerCase()] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
        } catch (e) {
          out[pair.slice(0, i).toLowerCase()] = pair.slice(i + 1);
        }
      }
    });
    return out;
  }

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  const WIFI_SECURITY = { WPA: 'WPA2-PSK', WPA2: 'WPA2-PSK', WPA3: 'SAE', SAE: 'SAE', WEP: 'WEP' };

  function wifi(text) {
    const f = fields(text.slice(5));
    const type = (f.T || '').toUpperCase();
    const security = f.P && WIFI_SECURITY[type] ? WIFI_SECURITY[type] : (f.P ? 'WPA2-PSK' : 'OPEN');
    const data = { ssid: f.S || '', password: f.P || '', security, hidden: /^true$/i.test(f.H || '') };
    return {
      kind: 'wifi', label: 'Wi-Fi network', title: data.ssid || '(no name)',
      lines: [data.password ? `Password: ${data.password}` : 'No password',
        security === 'OPEN' ? 'Open network' : `Security: ${type || 'WPA'}`].concat(data.hidden ? ['Hidden network'] : []),
      data,
    };
  }

  function vcardValue(line) {
    const i = line.indexOf(':');
    return i < 0 ? '' : line.slice(i + 1).replace(/\\([,;\\n])/g, (m, c) => (c === 'n' ? ' ' : c)).trim();
  }

  function contact(text) {
    const c = { givenName: '', familyName: '', name: '', tel: [], email: [], company: '', url: '' };
    if (/^MECARD:/i.test(text)) {
      const f = fields(text.slice(7));
      const [family, given] = (f.N || '').split(',');
      c.familyName = (family || '').trim();
      c.givenName = (given || '').trim();
      c.name = [c.givenName, c.familyName].filter(Boolean).join(' ');
      c.tel = f.TELs || [];
      c.email = f.EMAILs || [];
      c.company = f.ORG || '';
      c.url = f.URL || '';
    } else {
      text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).forEach((line) => {
        const name = line.split(/[:;]/)[0].toUpperCase();
        const value = vcardValue(line);
        if (name === 'FN') {
          c.name = value;
        } else if (name === 'N') {
          const [family, given] = value.split(';');
          c.familyName = (family || '').trim();
          c.givenName = (given || '').trim();
        } else if (name === 'TEL' && value) {
          c.tel.push(value.replace(/^tel:/i, ''));
        } else if (name === 'EMAIL' && value) {
          c.email.push(value);
        } else if (name === 'ORG') {
          c.company = value.split(';')[0];
        } else if (name === 'URL') {
          c.url = value;
        }
      });
      if (!c.name) {
        c.name = [c.givenName, c.familyName].filter(Boolean).join(' ');
      }
    }
    return {
      kind: 'contact', label: 'Contact', title: c.name || c.company || c.tel[0] || c.email[0] || 'Contact',
      lines: [].concat(c.company && c.name ? [c.company] : [], c.tel, c.email, c.url ? [c.url] : []),
      data: c,
    };
  }

  function sms(text) {
    let number = '';
    let body = '';
    let m = text.match(/^(?:smsto|mmsto):([^:]*)(?::([\s\S]*))?$/i);
    if (m) {
      number = m[1];
      body = m[2] || '';
    } else {
      m = text.match(/^(?:sms|mms):([^?]*)(?:\?(.*))?$/i);
      number = safeDecode(m ? m[1] : '');
      body = m ? query(m[2]).body || '' : '';
    }
    number = number.trim();
    return { kind: 'sms', label: 'Text message', title: number || '(no number)', lines: body ? [body] : [], data: { number, body } };
  }

  function email(text) {
    let to = '';
    let subject = '';
    let body = '';
    if (/^MATMSG:/i.test(text)) {
      const f = fields(text.slice(7));
      to = f.TO || '';
      subject = f.SUB || '';
      body = f.BODY || '';
    } else {
      const m = text.match(/^mailto:([^?]*)(?:\?(.*))?$/i);
      to = safeDecode(m[1]);
      const q = query(m[2]);
      subject = q.subject || '';
      body = q.body || '';
    }
    let url = `mailto:${to}`;
    const params = [];
    if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
    if (body) params.push(`body=${encodeURIComponent(body)}`);
    if (params.length) url += `?${params.join('&')}`;
    return {
      kind: 'email', label: 'Email', title: to || '(no address)',
      lines: [].concat(subject ? [`Subject: ${subject}`] : [], body ? [body] : []),
      data: { to, subject, body, url },
    };
  }

  function parse(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (/^WIFI:/i.test(text)) {
      return wifi(text);
    }
    if (/^(MECARD:|BEGIN:VCARD)/i.test(text)) {
      return contact(text);
    }
    if (/^(smsto|mmsto|sms|mms):/i.test(text)) {
      return sms(text);
    }
    if (/^(mailto:|MATMSG:)/i.test(text)) {
      return email(text);
    }
    let m = text.match(/^tel:(.+)$/i);
    if (m) {
      const number = safeDecode(m[1]).trim();
      return { kind: 'tel', label: 'Phone number', title: number, lines: [], data: { number } };
    }
    m = text.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
    if (m) {
      const [lat, lng] = [m[1], m[2]];
      return {
        kind: 'geo', label: 'Location', title: `${lat}, ${lng}`, lines: [],
        data: { lat, lng, url: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` },
      };
    }
    if (/^https?:\/\/\S+$/i.test(text) || /^www\.[^\s.]+\.\S+$/i.test(text)) {
      const url = /^www\./i.test(text) ? `https://${text}` : text;
      return { kind: 'url', label: 'Link', title: url, lines: [], data: { url } };
    }
    return { kind: 'text', label: 'Text', title: text, lines: [], data: { text } };
  }

  exports.QrParse = { parse, fields };
  if (typeof module !== 'undefined') {
    module.exports = exports.QrParse;
  }
}(typeof window !== 'undefined' ? window : globalThis));

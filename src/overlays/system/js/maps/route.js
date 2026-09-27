'use strict';

var MapsRoute = (function() {
  const MODES = ['drive', 'bicycle', 'walk', 'transit'];

  const TUNING = {
    drive: { reach: 30, prepare: 400, now: 60, offRoute: 100, zoom: 16 },
    bicycle: { reach: 20, prepare: 120, now: 30, offRoute: 80, zoom: 17 },
    walk: { reach: 12, prepare: 50, now: 15, offRoute: 40, zoom: 17 },
  };

  const EARTH = 6371008.8;
  const RAD = Math.PI / 180;

  function distance(a, b) {
    const dLat = (b.lat - a.lat) * RAD;
    const dLng = (b.lng - a.lng) * RAD;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH * Math.asin(Math.sqrt(h));
  }

  function bearing(a, b) {
    const y = Math.sin((b.lng - a.lng) * RAD) * Math.cos(b.lat * RAD);
    const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
      Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - a.lng) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }

  function toSegment(p, a, b) {
    const kx = Math.cos(a.lat * RAD) * RAD * EARTH;
    const ky = RAD * EARTH;
    const bx = (b.lng - a.lng) * kx;
    const by = (b.lat - a.lat) * ky;
    const px = (p.lng - a.lng) * kx;
    const py = (p.lat - a.lat) * ky;
    const len2 = bx * bx + by * by;
    const t = len2 ? (px * bx + py * by) / len2 : 0;
    const c = Math.max(0, Math.min(1, t));
    return { dist: Math.hypot(px - c * bx, py - c * by), t };
  }

  function nearestSegment(p, points) {
    let best = { index: 0, dist: Infinity };
    for (let i = 0; i < points.length - 1; i++) {
      const d = toSegment(p, points[i], points[i + 1]).dist;
      if (d < best.dist) {
        best = { index: i, dist: d };
      }
    }
    return best;
  }

  function point(p) {
    return Array.isArray(p) && typeof p[2] === 'number' && typeof p[3] === 'number' ?
      { lat: p[2], lng: p[3] } : null;
  }

  function isStep(x) {
    return Array.isArray(x) && Array.isArray(x[0]) && Array.isArray(x[0][2]) &&
      Array.isArray(x[0][7]) && point(x[0][7][2]) !== null &&
      Array.isArray(x[2]) && typeof x[2][1] === 'string';
  }

  function collectSteps(node, out) {
    if (isStep(node)) {
      out.push(node);
    } else if (Array.isArray(node)) {
      node.forEach(child => collectSteps(child, out));
    }
    return out;
  }

  function parseStep(x) {
    const info = x[0];
    const parts = Array.isArray(info[14]) ? info[14] : [];
    const text = parts.length ?
      parts.map(part => part[1][0]).join('') :
      String(info[1] || '').replace(/<[^>]*>/g, '');
    const maneuver = /dir-tt-([a-z-]+)/.exec(x[2][1]);
    return Object.assign({
      text: text.trim(),
      meters: info[2][0],
      seconds: info[3][0],
      maneuver: maneuver ? maneuver[1] : 'straight',
    }, point(info[7][2]));
  }

  function parseRoute(r) {
    const summary = r[0];
    const leg = r[1][0];
    const dest = leg[4];
    return {
      mode: MODES[summary[0]] || null,
      via: summary[1] || '',
      meters: summary[2][0],
      seconds: summary[3][0],
      imperial: /\b(mi|miles?|ft)\b/.test(summary[2][1]),
      steps: collectSteps(leg[1], []).map(parseStep),
      dest: Object.assign({ name: dest[0][1] }, point(dest[2][2])),
    };
  }

  function parseDirections(text) {
    const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
    if (!Array.isArray(data[0]) || !Array.isArray(data[0][1])) {
      throw new Error('no routes in the directions response');
    }
    return data[0][1].map(parseRoute);
  }

  function chooseRoute(routes, mode, cardText) {
    const usable = routes.filter(r => r.mode === mode && r.steps.length && r.dest.lat !== undefined);
    return usable.find(r => r.via && cardText.includes(`Via ${r.via}`)) || usable[0] || null;
  }

  function modeFromUrl(url) {
    const m = /\/data=[^?]*!3e(\d+)/.exec(url);
    return m && MODES[m[1]] || null;
  }

  function rerouteUrl(url, lat, lng) {
    return url.replace(/([?&]pb=)([^&]*)/, (all, key, pb) => {
      const tokens = pb.split('!').slice(1);
      const origin = /^1m(\d+)$/.exec(tokens[0]);
      if (!origin) {
        throw new Error(`unexpected directions request: ${pb.slice(0, 40)}`);
      }
      tokens.splice(0, 1 + Number(origin[1]), '1m1', `1s${lat.toFixed(6)},${lng.toFixed(6)}`);
      return `${key}!${tokens.join('!')}`;
    });
  }

  function worldPixel(lat, lng, z) {
    const size = 256 * 2 ** z;
    const s = Math.sin(lat * RAD);
    return {
      x: (lng + 180) / 360 * size,
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size,
    };
  }

  function tileUrl(template, z, x, y) {
    return template.replace(/!1i\d+!2i\d+!3i\d+/, `!1i${z}!2i${x}!3i${y}`);
  }

  function distanceParts(metres, imperial) {
    if (imperial) {
      const feet = metres * 3.28084;
      if (feet < 500) {
        return [String(feet < 100 ? Math.max(10, Math.round(feet / 10) * 10) : Math.round(feet / 50) * 50), 'ft'];
      }
      const miles = metres / 1609.344;
      return [miles < 10 ? miles.toFixed(1) : String(Math.round(miles)), 'mi'];
    }
    if (metres < 950) {
      return [String(metres < 100 ? Math.max(5, Math.round(metres / 5) * 5) : Math.round(metres / 50) * 50), 'm'];
    }
    const km = metres / 1000;
    return [km < 10 ? km.toFixed(1) : String(Math.round(km)), 'km'];
  }

  const SPOKEN = {
    ft: ['foot', 'feet'], mi: ['mile', 'miles'], m: ['meter', 'meters'], km: ['kilometer', 'kilometers'],
  };

  function spokenDistance(metres, imperial) {
    const [number, unit] = distanceParts(metres, imperial);
    const one = Number(number) === 1;
    return `${one ? '1' : number} ${SPOKEN[unit][one ? 0 : 1]}`;
  }

  function formatDuration(seconds) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) {
      return `${minutes} min`;
    }
    const rest = minutes % 60;
    return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`;
  }

  function lowerFirst(text) {
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  class Guidance {
    constructor(route) {
      this.route = route;
      this.tune = TUNING[route.mode] || TUNING.drive;
      this.points = route.steps.concat([route.dest]);
      this.next = 0;
      this.arrived = false;
    }

    enter(fix, reached) {
      const from = this.points[this.next - 1];
      this.reached = reached;
      this.closest = Infinity;
      this.strikes = 0;
      this.said = 0;
      this.traveled = from ? distance(from, fix) : 0;
      this.last = fix;
      this.offRoute = false;
    }

    toNext(d) {
      return d < 250 ? d : Math.max(d, this.route.steps[this.next - 1].meters - this.traveled);
    }

    instruction(i) {
      const step = this.route.steps[i];
      return step ? step : { text: `Arrive at ${this.route.dest.name}`, maneuver: 'destination' };
    }

    update(fix) {
      const points = this.points;
      const lastPoint = points.length - 1;
      const tune = this.tune;
      const speak = [];
      let buzz = false;

      let startedAway = false;
      if (!this.next) {
        const start = nearestSegment(fix, points);
        this.next = start.index + 1;
        this.enter(fix, false);
        startedAway = start.dist > tune.offRoute * 2 + fix.accuracy;
        speak.push(this.instruction(this.next - 1).text);
      }

      const reach = tune.reach + Math.min(fix.accuracy, 30);
      let d = distance(fix, points[this.next]);

      if (fix.accuracy <= 80 && !this.arrived) {
        const moved = distance(this.last, fix);
        if (moved >= Math.min(fix.accuracy, 20)) {
          this.traveled += moved;
          this.last = fix;
        }

        let advance = 0;
        let reached = false;
        if (this.reached) {
          if (this.next < lastPoint && d > reach * 1.3) {
            advance = 1;
          }
        } else if (d > reach) {
          for (let j = this.next + 1; j <= Math.min(lastPoint, this.next + 3); j++) {
            if (distance(fix, points[j]) <= reach) {
              advance = j - this.next;
              reached = true;
              break;
            }
          }
          if (!advance && this.next < lastPoint) {
            const ahead = toSegment(fix, points[this.next], points[this.next + 1]);
            const behind = toSegment(fix, points[this.next - 1], points[this.next]);
            if (ahead.t > 0 && ahead.dist < reach && ahead.dist < behind.dist) {
              advance = 1;
            }
          }
        }

        if (advance) {
          this.next += advance;
          this.enter(fix, reached);
          d = distance(fix, points[this.next]);
        }
        if (d <= reach) {
          this.reached = true;
        }
        this.arrived = this.reached && this.next === lastPoint;

        this.closest = Math.min(this.closest, d);
        const from = points[this.next - 1];
        const chord = distance(from, points[this.next]);
        const bow = Math.sqrt(3 * chord * Math.max(0, this.route.steps[this.next - 1].meters - chord) / 8);
        const astray = toSegment(fix, from, points[this.next]).dist > bow + tune.offRoute / 2 + fix.accuracy;
        const away = !this.reached && (d - this.closest > tune.offRoute + fix.accuracy || astray);
        this.strikes = away ? this.strikes + 1 : 0;
        this.offRoute = this.strikes >= 3;
      }

      const toNext = this.toNext(d);
      const imperial = this.route.imperial;
      if (this.arrived) {
        if (this.said < 4) {
          speak.push(`You have arrived at ${this.route.dest.name}`);
          buzz = true;
          this.said = 4;
        }
      } else {
        const { text } = this.instruction(this.next);
        const speed = fix.speed || 0;
        const now = Math.max(tune.now, speed * 5);
        const prepare = Math.max(tune.prepare, speed * 20);
        if (toNext <= now && this.said < 3 && this.next !== lastPoint) {
          speak.push(text);
          buzz = true;
          this.said = 3;
        } else if (toNext <= prepare && this.said < 2) {
          speak.push(`In ${spokenDistance(toNext, imperial)}, ${lowerFirst(text)}`);
          this.said = 2;
        } else if (this.said < 1) {
          if (toNext > prepare * 1.5) {
            speak.push(`In ${spokenDistance(toNext, imperial)}, ${lowerFirst(text)}`);
          }
          this.said = 1;
        }
      }

      const steps = this.route.steps;
      const current = steps[this.next - 1];
      let metres = toNext;
      let seconds = current.meters ? current.seconds * Math.min(1, toNext / current.meters) : 0;
      for (let i = this.next; i < steps.length; i++) {
        metres += steps[i].meters;
        seconds += steps[i].seconds;
      }

      const following = steps[this.next];
      const then = following && following.meters <= tune.prepare / 2 ?
        this.instruction(this.next + 1).maneuver : null;

      const { text, maneuver } = this.instruction(this.next);
      return {
        next: this.next,
        text,
        maneuver,
        toNext,
        then,
        metres,
        seconds,
        arrived: this.arrived,
        offRoute: this.offRoute || startedAway,
        heading: bearing(fix, points[this.next]),
        speak: speak.length ? speak.join('. ') : null,
        buzz,
      };
    }
  }

  return {
    TUNING, parseDirections, chooseRoute, modeFromUrl, rerouteUrl, worldPixel, tileUrl,
    distanceParts, spokenDistance, formatDuration, distance, Guidance,
  };
}());

if (typeof module === 'object') {
  module.exports = MapsRoute;
}

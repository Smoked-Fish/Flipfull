'use strict';

import { FlipfullCallRec as lib } from '../callrec/client/generated/callrec_service.js';
import { service } from './connect.js';

const START = 25 * 1000;
const STOP = 35 * 1000;

const callrec = service('FlipfullCallRec', lib);

function file(rec) {
  const parts = [];
  function next(offset) {
    return callrec.call((svc) => svc.read(offset), STOP).then((piece) => {
      if (!piece.length) {
        return new Blob(parts, { type: rec.type });
      }
      parts.push(piece);
      return next(offset + piece.length);
    });
  }
  return next(0);
}

window.FlipfullCallRec = Object.assign(window.FlipfullCallRec || {}, callrec.methods({ start: START, stop: STOP }), { file });

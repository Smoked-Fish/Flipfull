'use strict';

import { FlipfullSpeech as lib } from '../speech/client/generated/speech_service.js';
import { service } from './connect.js';

const PIECE = 512 * 1024;
const QUICK = 5 * 1000;
const SLOW = 75 * 1000;

const speech = service('FlipfullSpeech', lib);

function download(file, offset, bytes) {
  return speech.call((svc) => {
    let done = Promise.resolve();
    for (let at = 0; at < bytes.length; at += PIECE) {
      const piece = bytes.subarray(at, at + PIECE);
      const from = offset + at;
      done = done.then(() => svc.download(file, from, piece));
    }
    return done;
  }, SLOW);
}

function transcribe(bytes) {
  const clip = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return speech.call((svc) => {
    const sent = [svc.begin()];
    for (let at = 0; at < clip.length; at += PIECE) {
      sent.push(svc.append(clip.subarray(at, at + PIECE)));
    }
    return Promise.all(sent).then(() => svc.transcribe());
  }, SLOW);
}

window.FlipfullSpeech = Object.assign(speech.methods({
  open: QUICK,
  close: QUICK,
  health: QUICK,
  models: QUICK,
  useModel: QUICK,
  deleteModel: QUICK,
}), { download, transcribe });

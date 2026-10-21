'use strict';

import { FlipfullRetro as lib } from '../retro/client/generated/retro_service.js';
import { service } from './connect.js';

const QUICK = 5 * 1000;
const SLOW = 60 * 1000;

const retro = service('FlipfullRetro', lib);

window.FlipfullRetro = {
    info() {
        return retro.call((svc) => svc.info(), QUICK);
    },
    stream() {
        return retro.call((svc) => svc.stream(), QUICK);
    },
    games() {
        return retro.call((svc) => svc.games(), SLOW);
    },
    load(path) {
        return retro.call((svc) => svc.load(path), SLOW);
    },
    reset() {
        return retro.call((svc) => svc.reset(), QUICK);
    },
    states() {
        return retro.call((svc) => svc.states(), QUICK);
    },
    saveState(slot) {
        return retro.call((svc) => svc.saveState(slot), SLOW);
    },
    loadState(slot) {
        return retro.call((svc) => svc.loadState(slot), SLOW);
    },
    unload() {
        return retro.call((svc) => svc.unload(), QUICK);
    },
};

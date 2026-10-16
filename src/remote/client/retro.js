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
    load(rom, save) {
        return retro.call((svc) => svc.load(rom, save), SLOW);
    },
    save() {
        return retro.call((svc) => svc.save(), QUICK);
    },
    unload() {
        return retro.call((svc) => svc.unload(), QUICK);
    },
};

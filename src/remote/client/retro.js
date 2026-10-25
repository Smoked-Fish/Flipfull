'use strict';

import { FlipfullRetro as lib } from '../retro/client/generated/retro_service.js';
import { service } from './connect.js';

const QUICK = 5 * 1000;
const SLOW = 60 * 1000;

const retro = service('FlipfullRetro', lib);

window.FlipfullRetro = retro.methods({
    info: QUICK,
    stream: QUICK,
    games: SLOW,
    load: SLOW,
    reset: QUICK,
    states: QUICK,
    saveState: SLOW,
    loadState: SLOW,
    settings: QUICK,
    set: QUICK,
    unload: QUICK,
});

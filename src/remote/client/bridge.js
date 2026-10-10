'use strict';

import { FlipfullBridge as lib } from '../bridge/client/generated/bridge_service.js';
import { service } from './connect.js';

const TIMEOUT = 610 * 1000;

const bridge = service('FlipfullBridge', lib);

window.FlipfullBridge = {
  run(...words) {
    return bridge.call((svc) => svc.run(words), TIMEOUT);
  },
};

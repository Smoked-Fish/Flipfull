'use strict';

const DAEMON = '127.0.0.1';

export function offline(message) {
  const e = new Error(message);
  e.offline = true;
  return e;
}

function failed(name, err) {
  const v = err && err.value;
  if (v && typeof v.message === 'string') {
    const e = new Error(v.message);
    e.offline = v.offline;
    return e;
  }
  if (err instanceof Error) {
    return err;
  }
  return offline(`${name}: ${(err && (err.reason || err.error)) || err}`);
}

export function service(name, lib) {
  let pending = null;
  let session = null;

  function drop(s) {
    if (session === s) {
      session = null;
      pending = null;
    }
    try {
      s.close();
    } catch (e) {}
  }

  function open() {
    if (!(navigator.b2g && navigator.b2g.externalapi)) {
      return Promise.reject(offline('no api-daemon in this browser'));
    }
    return navigator.b2g.externalapi.getToken().then((token) => new Promise((resolve, reject) => {
      const s = new lib_session.Session();
      let up = false;
      session = s;
      s.open('websocket', DAEMON, token, {
        onsessionconnected() {
          up = true;
          lib.get(s).then(resolve, (why) => {
            drop(s);
            reject(offline(`${name} isn't available: ${why}`));
          });
        },
        onsessiondisconnected() {
          drop(s);
        },
        onsessionconnectionerror() {
          drop(s);
          if (!up) {
            reject(offline("api-daemon didn't answer"));
          }
        },
      }, false);
    }));
  }

  function get() {
    if (!pending) {
      pending = open();
      pending.catch(() => {
        pending = null;
      });
    }
    return pending;
  }

  function call(fn, timeoutMs) {
    return get().then((svc) => new Promise((resolve, reject) => {
      const s = session;
      const timer = setTimeout(() => {
        if (s) {
          drop(s);
        }
        reject(offline(`${name} didn't answer`));
      }, timeoutMs);
      fn(svc).then((v) => {
        clearTimeout(timer);
        resolve(v);
      }, (err) => {
        clearTimeout(timer);
        reject(failed(name, err));
      });
    }));
  }

  function methods(timeouts) {
    const out = {};
    Object.keys(timeouts).forEach((name) => {
      out[name] = (...args) => call((svc) => svc[name](...args), timeouts[name]);
    });
    return out;
  }

  return { call, methods };
}

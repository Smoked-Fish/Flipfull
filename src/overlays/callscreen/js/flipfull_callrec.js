'use strict';

(function(exports) {
  const SCRIPTS = [
    ['ExternalAPI', 'http://127.0.0.1/api/v1/shared/core.js'],
    ['lib_session', 'http://127.0.0.1/api/v1/shared/session.js'],
    ['FlipfullCallrecService', 'http://127.0.0.1/flipfull/callrec.js'],
  ];

  let loading = null;

  function log(msg) {
    const line = `[Flipfull] call recording: ${msg}`;
    typeof DUMP === 'function' ? DUMP(line) : console.log(line);
  }

  function script(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`${src} didn't load`));
      document.head.appendChild(s);
    });
  }

  function service() {
    if (!loading) {
      loading = SCRIPTS.reduce((done, [name, src]) => done.then(() => exports[name] ? null : script(src)),
        Promise.resolve());
      loading.catch(() => {
        loading = null;
      });
    }
    return loading.then(() => exports.FlipfullCallrecService);
  }

  function open() {
    return service().then(s => s.start()).then(() => {
      log('recording');
      return {};
    }, e => {
      log(`can't record: ${e.message}`);
      throw e;
    });
  }

  function Recorder() {
    this.state = 'inactive';
    this.stoppedAt = null;
    this.ondataavailable = null;
    this.onstop = null;
  }

  Recorder.prototype.start = function() {
    this.state = 'recording';
  };

  Recorder.prototype.stop = function() {
    if (this.state !== 'recording') {
      return;
    }
    this.state = 'inactive';
    this.stoppedAt = new Date();
    service()
      .then(s => s.stop().then(info => {
        log(`recorded ${info.seconds} s as ${info.file}, peak level ${info.peak}`);
        exports.FlipfullCallRec.ext = info.ext;
        return s.file(info);
      }))
      .then(blob => {
        if (this.ondataavailable) {
          this.ondataavailable({ data: blob });
        }
      })
      .catch(e => log(`recording lost: ${e.message}`))
      .then(() => {
        if (this.onstop) {
          this.onstop();
        }
      });
  };

  exports.FlipfullCallRec = { open, Recorder, ext: '' };
})(window);

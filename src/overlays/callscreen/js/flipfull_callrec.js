'use strict';

(function(exports) {
  const SERVICE = 'http://127.0.0.1:8322';

  function log(msg) {
    const line = `[Flipfull] call recording: ${msg}`;
    typeof DUMP === 'function' ? DUMP(line) : console.log(line);
  }

  function request(method, path) {
    return fetch(SERVICE + path, { method, cache: 'no-store' }).then(r =>
      r.json().catch(() => ({})).then(body => {
        if (!r.ok || body.error) {
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return body;
      }));
  }

  function open() {
    return request('POST', '/start').then(() => {
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
    request('POST', '/stop')
      .then(info => {
        log(`recorded ${info.seconds} s as ${info.file}, peak level ${info.peak}`);
        exports.FlipfullCallRec.ext = info.ext;
        return fetch(`${SERVICE}/file`, { cache: 'no-store' });
      })
      .then(r => {
        if (!r.ok) {
          throw new Error(`file: HTTP ${r.status}`);
        }
        return r.blob();
      })
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

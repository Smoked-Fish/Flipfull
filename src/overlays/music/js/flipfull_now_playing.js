'use strict';

(function(exports) {
  let cover = null;
  let known = null;
  let resend = null;

  function on() {
    return !!(window.FlipfullFeatures && window.FlipfullFeatures['outer-screen-music']);
  }

  function metadata(m) {
    if (!on()) {
      return;
    }
    const song = `${m.title}\n${m.artist}\n${m.album}`;
    if (m.picture) {
      const old = cover;
      cover = { url: URL.createObjectURL(m.picture), song };
      old && setTimeout(() => URL.revokeObjectURL(old.url), 5000);
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: m.title,
      artist: m.artist,
      album: m.album,
      artwork: cover && cover.song === song ? [{ src: cover.url }] : []
    });
    if (m.picture) {
      setPosition(m.duration / 1000, 0);
    }
  }

  function status(s) {
    if (!on()) {
      return;
    }
    clearTimeout(resend);
    if (s.playStatus === 'STOPPED') {
      known = null;
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    setPosition(s.duration / 1000, s.position / 1000);
    navigator.mediaSession.playbackState = s.playStatus === 'PLAYING' ? 'playing' : 'paused';
    if (s.playStatus === 'PLAYING') {
      resend = setTimeout(() => known && setPosition(known.duration,
        Math.min(known.duration, known.position + (Date.now() - known.time) / 1000)), 1000);
    }
  }

  function setPosition(duration, position) {
    known = duration > 0 && position >= 0 && position <= duration ?
      { duration, position, time: Date.now() } : null;
    if (known) {
      navigator.mediaSession.setPositionState({ duration, position, playbackRate: 1 });
    }
  }

  exports.FlipfullNowPlaying = { metadata, status };
}(window));

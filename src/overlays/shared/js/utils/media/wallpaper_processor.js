!function(exports) {
  'use strict';

  const DIR = '/sdcard/.wallpaper/';
  const BASENAME = 'custom_wallpaper';

  const WallpaperProcessor = {
    LOW_MEMORY_VALUE: 256,
    MAX_IMAGE_PIXEL_SIZE: 5242880,
    LOW_MAX_IMAGE_PIXEL_SIZE: 5242880,
    LOW_MAX_IMAGE_PIXEL_SIZE_NO_JPEG: 1431136,
    MAX_UNKNOWN_IMAGE_SIZE: 524288,
    MIN_UNKNOWN_IMAGE_SIZE: 32,
    MAX_ANIMATED_FILE_SIZE: 8388608,
    MAX_ANIMATED_PIXEL_SIZE: 307200,
    MAX_VIDEO_FILE_SIZE: 20971520,
    MAX_VIDEO_PIXEL_SIZE: 921600,
    VIDEO_LOAD_TIMEOUT: 10000,
    WALLPAPER_SETTINGS_KEY: 'wallpaper.image',
    LIVE_SETTINGS_KEY: 'wallpaper.live',
    LEGACY_VIDEO_SETTINGS_KEY: 'wallpaper.video',
    HARDWARE_MEMORY_KEY: 'hardware.memory',
    WALLPAPER_IMAGE_PATCH: DIR + BASENAME + '.jpg',
    LEGACY_FILES: ['jpg', 'gif', 'webp', 'mp4'].map(ext => DIR + BASENAME + '.' + ext),
    SCREEN_WIDTH: Math.round(Math.min(screen.width, screen.height) * window.devicePixelRatio),
    SCREEN_HEIGHT: Math.round(Math.max(screen.width, screen.height) * window.devicePixelRatio),
    lowMemory: null,
    storageType: { external: 'sdcard1', internal: 'sdcard' },
    errorMessages: {
      corruptImage: 'image-invalid',
      tooLargeImage: 'image-too-big',
      notEnoughStorage: 'not-enough-storage'
    },
    offscreenImage: null,
    offscreenImageURL: null,

    getDeviceStorageByFileName(fileName) {
      const [, storageName] = fileName.split('/');
      const storages = navigator.b2g.getDeviceStorages(this.storageType.internal);
      return storages.find(s => s.storageName === storageName) || null;
    },

    getFileBlob(fileName) {
      return new Promise((resolve, reject) => {
        const storage = this.getDeviceStorageByFileName(fileName);
        if (!storage) {
          reject(this.errorMessages.corruptImage);
          return;
        }
        const req = storage.get(fileName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(this.errorMessages.corruptImage);
      });
    },

    saveBlob(blob, path) {
      return new Promise((resolve, reject) => {
        const storage = navigator.b2g.getDeviceStorage(this.storageType.internal);
        const add = () => {
          getStorageIfAvailable(this.storageType.internal, blob.size, () => {
            const req = storage.addNamed(blob, path);
            req.onsuccess = () => resolve(req.result.name);
            req.onerror = () => reject(this.errorMessages.corruptImage);
          }, () => reject(this.errorMessages.notEnoughStorage));
        };
        const del = storage.delete(path);
        del.onsuccess = add;
        del.onerror = add;
      });
    },

    deleteFiles(paths) {
      const storage = navigator.b2g.getDeviceStorage(this.storageType.internal);
      return Promise.all(paths.map(path => new Promise(resolve => {
        const req = storage.delete(path);
        req.onsuccess = resolve;
        req.onerror = resolve;
      })));
    },

    sniff(blob) {
      if (!blob) {
        return Promise.resolve({ type: 'image' });
      }
      return blob.slice(0, 32).arrayBuffer().then(buf => {
        const b = new Uint8Array(buf);
        const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
        if (ascii(4, 8) === 'ftyp' || blob.type === 'video/mp4') {
          return { type: 'mp4' };
        }
        if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') {
          const info = { width: b[6] | b[7] << 8, height: b[8] | b[9] << 8 };
          if (blob.size > this.MAX_ANIMATED_FILE_SIZE) {
            return Object.assign(info, { type: 'image' });
          }
          return blob.arrayBuffer().then(all => Object.assign(info, {
            type: this.gifFrameCount(new Uint8Array(all), 2) > 1 ? 'gif' : 'image'
          }));
        }
        if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' && ascii(12, 16) === 'VP8X') {
          const animated = (b[20] & 0x02) !== 0;
          return {
            type: animated ? 'webp' : 'image',
            width: 1 + (b[24] | b[25] << 8 | b[26] << 16),
            height: 1 + (b[27] | b[28] << 8 | b[29] << 16)
          };
        }
        return { type: 'image' };
      }).catch(() => ({ type: 'image' }));
    },

    gifFrameCount(b, stopAt) {
      let i = 13;
      if (b[10] & 0x80) {
        i += 3 << ((b[10] & 7) + 1);
      }
      let frames = 0;
      const skipSubBlocks = () => {
        while (i < b.length && b[i] !== 0) {
          i += b[i] + 1;
        }
        i++;
      };
      while (i < b.length && frames < stopAt) {
        if (b[i] === 0x21) {
          i += 2;
          skipSubBlocks();
        } else if (b[i] === 0x2c) {
          frames++;
          const flags = b[i + 9];
          i += 10;
          if (flags & 0x80) {
            i += 3 << ((flags & 7) + 1);
          }
          i++;
          skipSubBlocks();
        } else {
          break;
        }
      }
      return frames;
    },

    getMediaType(blob) {
      return this.sniff(blob).then(info => info.type);
    },

    cropBlob(blob, sampleSize) {
      return new Promise((resolve, reject) => {
        this.offscreenImageURL = URL.createObjectURL(blob);
        this.offscreenImage = new Image();
        this.offscreenImage.onerror = () => {
          this.cleanupImage();
          reject(this.errorMessages.corruptImage);
        };
        this.offscreenImage.onload = () => {
          const img = this.offscreenImage;
          this.drawCover(img, img.width, img.height).then(result => {
            this.cleanupImage();
            resolve(result);
          });
        };
        this.offscreenImage.src = sampleSize ?
          this.offscreenImageURL + sampleSize : this.offscreenImageURL;
      });
    },

    drawCover(source, width, height) {
      return new Promise(resolve => {
        const scale = Math.max(this.SCREEN_WIDTH / width, this.SCREEN_HEIGHT / height);
        const sw = Math.round(this.SCREEN_WIDTH / scale);
        const sh = Math.round(this.SCREEN_HEIGHT / scale);
        const canvas = document.createElement('canvas');
        canvas.width = this.SCREEN_WIDTH;
        canvas.height = this.SCREEN_HEIGHT;
        canvas.getContext('2d').drawImage(source,
          Math.floor((width - sw) / 2), Math.floor((height - sh) / 2), sw, sh,
          0, 0, this.SCREEN_WIDTH, this.SCREEN_HEIGHT);
        canvas.toBlob(blob => {
          canvas.width = 0;
          resolve(blob);
        }, 'image/jpeg', 0.92);
      });
    },

    getDownResolutionBlob(blob) {
      return new Promise((resolve, reject) => {
        getImageSize(blob, info => {
          const pixels = info.width * info.height;
          let max = this.lowMemory ? this.LOW_MAX_IMAGE_PIXEL_SIZE : this.MAX_IMAGE_PIXEL_SIZE;
          if (info.type !== 'jpeg' && this.lowMemory) {
            max = this.LOW_MAX_IMAGE_PIXEL_SIZE_NO_JPEG;
          }
          if (pixels > max || blob.size > 2 * max) {
            reject(this.errorMessages.tooLargeImage);
            return;
          }
          const sample = Downsample.areaNoMoreThan(this.SCREEN_WIDTH * this.SCREEN_HEIGHT / pixels);
          this.cropBlob(blob, sample).then(resolve, reject);
        }, () => {
          if (blob.size > this.MAX_UNKNOWN_IMAGE_SIZE || blob.size < this.MIN_UNKNOWN_IMAGE_SIZE) {
            reject(this.errorMessages.corruptImage);
            return;
          }
          blob.arrayBuffer()
            .then(buf => this.cropBlob(new Blob([new Uint8Array(buf)])))
            .then(resolve, reject);
        });
      });
    },

    getImagePoster(blob) {
      return this.cropBlob(blob);
    },

    getVideoPoster(blob) {
      if (blob.size > this.MAX_VIDEO_FILE_SIZE) {
        return Promise.reject(this.errorMessages.tooLargeImage);
      }
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const video = document.createElement('video');
        let timer = null;
        const done = (err, poster) => {
          clearTimeout(timer);
          video.onloadeddata = video.onerror = null;
          video.removeAttribute('src');
          video.load();
          URL.revokeObjectURL(url);
          err ? reject(err) : resolve(poster);
        };
        timer = setTimeout(() => done(this.errorMessages.corruptImage), this.VIDEO_LOAD_TIMEOUT);
        video.muted = true;
        video.preload = 'auto';
        video.onerror = () => done(this.errorMessages.corruptImage);
        video.onloadeddata = () => {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (!w || !h) {
            done(this.errorMessages.corruptImage);
          } else if (w * h > this.MAX_VIDEO_PIXEL_SIZE) {
            done(this.errorMessages.tooLargeImage);
          } else {
            this.drawCover(video, w, h).then(poster => done(null, poster));
          }
        };
        video.src = url;
      });
    },

    toMemory(blob, type) {
      return blob.arrayBuffer().then(buf => new Blob([buf], { type }));
    },

    prepareBlob(blob) {
      return this.sniff(blob).then(info => {
        if (info.type === 'mp4') {
          return this.getVideoPoster(blob).then(poster =>
            this.toMemory(blob, 'video/mp4').then(copy =>
              ({ poster, live: { blob: copy, ext: 'mp4' }, preview: poster })));
        }
        if (info.type === 'gif' || info.type === 'webp') {
          if (blob.size > this.MAX_ANIMATED_FILE_SIZE ||
              info.width * info.height > this.MAX_ANIMATED_PIXEL_SIZE) {
            return Promise.reject(this.errorMessages.tooLargeImage);
          }
          const type = info.type === 'gif' ? 'image/gif' : 'image/webp';
          return this.toMemory(blob, type).then(copy =>
            this.getImagePoster(copy).then(poster =>
              ({ poster, live: { blob: copy, ext: info.type }, preview: copy })));
        }
        return this.getDownResolutionBlob(blob).then(poster =>
          ({ poster, live: null, preview: poster }));
      });
    },

    saveAndApply(prepared) {
      const stamp = Date.now().toString(36);
      const posterPath = `${DIR}${BASENAME}_${stamp}.jpg`;
      const livePath = prepared.live ? `${DIR}${BASENAME}_${stamp}.${prepared.live.ext}` : '';
      let previous = [];

      return Promise.all([
        SettingsObserver.getValue(this.WALLPAPER_SETTINGS_KEY),
        SettingsObserver.getValue(this.LIVE_SETTINGS_KEY),
        SettingsObserver.getValue(this.LEGACY_VIDEO_SETTINGS_KEY)
      ]).then(values => {
        previous = values.filter(v => typeof v === 'string' && v.startsWith(DIR));
      }, () => {}).then(() =>
        livePath ? this.saveBlob(prepared.live.blob, livePath) : null
      ).then(() =>
        this.saveBlob(prepared.poster, posterPath)
      ).then(() => SettingsObserver.setValue([
        { name: this.LIVE_SETTINGS_KEY, value: livePath },
        { name: this.LEGACY_VIDEO_SETTINGS_KEY, value: '' },
        { name: this.WALLPAPER_SETTINGS_KEY, value: posterPath }
      ])).then(() => {
        const keep = [posterPath, livePath];
        return this.deleteFiles(previous.concat(this.LEGACY_FILES)
          .filter((p, i, all) => !keep.includes(p) && all.indexOf(p) === i));
      });
    },

    getWallpaperBlob(fileName, onSuccess, onError) {
      this.init().then(() => this.getFileBlob(fileName))
        .then(blob => this.prepareBlob(blob))
        .then(prepared => onSuccess(prepared.preview))
        .catch(err => onError(err));
    },

    getWallpaperBlobByBlob(blob, onSuccess, onError) {
      this.init().then(() => this.prepareBlob(blob))
        .then(prepared => onSuccess(prepared.preview))
        .catch(err => onError(err));
    },

    setWallpaper(fileName, onSuccess, onError) {
      this.init().then(() => this.getFileBlob(fileName))
        .then(blob => this.prepareBlob(blob))
        .then(prepared => this.saveAndApply(prepared))
        .then(onSuccess)
        .catch(err => onError(err));
    },

    setWallpaperByBlob(blob, onSuccess, onError) {
      this.init().then(() => this.prepareBlob(blob))
        .then(prepared => this.saveAndApply(prepared))
        .then(onSuccess)
        .catch(err => onError(err));
    },

    init() {
      return new Promise(resolve => {
        const scripts = [];
        const base = 'http://shared.localhost/js/utils/';
        window.getStorageIfAvailable || scripts.push(base + 'device_storage/get_storage_if_available.js');
        window.getImageSize || scripts.push(base + 'media/image_size.js');
        window.parseJPEGMetadata || scripts.push(base + 'media/jpeg_metadata_parser.js');
        window.Downsample || scripts.push(base + 'media/downsample.js');
        window.BlobView || scripts.push(base + 'blob/blobview.js');
        const ready = () => {
          if (this.lowMemory === null) {
            this.checkIsLowMemory().then(resolve);
          } else {
            resolve();
          }
        };
        scripts.length ? LazyLoader.load(scripts, ready) : ready();
      });
    },

    checkIsLowMemory() {
      return DeviceCapabilityManager.get(this.HARDWARE_MEMORY_KEY).then(memory => {
        this.lowMemory = memory === this.LOW_MEMORY_VALUE;
      });
    },

    cleanupImage() {
      this.offscreenImage.onerror = '';
      this.offscreenImage.onload = '';
      this.offscreenImage.src = '';
      URL.revokeObjectURL(this.offscreenImageURL);
      this.offscreenImageURL = null;
      this.offscreenImage = null;
    }
  };

  exports.WallpaperProcessor = WallpaperProcessor;
}(window);

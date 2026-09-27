#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <sys/mman.h>

#define DRM_IOCTL_BASE 'd'
#define DRM_IOW(nr, t)  _IOW(DRM_IOCTL_BASE, nr, t)
#define DRM_IOWR(nr, t) _IOWR(DRM_IOCTL_BASE, nr, t)

struct drm_gem_close { uint32_t handle, pad; };
struct drm_set_client_cap { uint64_t capability, value; };
struct drm_prime_handle { uint32_t handle, flags; int32_t fd; };
struct drm_mode_fb_cmd { uint32_t fb_id, width, height, pitch, bpp, depth, handle; };
struct drm_mode_get_plane {
    uint32_t plane_id, crtc_id, fb_id, possible_crtcs, gamma_size, count_format_types;
    uint64_t format_type_ptr;
};
struct dma_buf_sync { uint64_t flags; };

#define DRM_IOCTL_GEM_CLOSE           DRM_IOW(0x09, struct drm_gem_close)
#define DRM_IOCTL_SET_CLIENT_CAP      DRM_IOW(0x0d, struct drm_set_client_cap)
#define DRM_IOCTL_PRIME_HANDLE_TO_FD  DRM_IOWR(0x2d, struct drm_prime_handle)
#define DRM_IOCTL_MODE_GETFB          DRM_IOWR(0xAD, struct drm_mode_fb_cmd)
#define DRM_IOCTL_MODE_GETPLANE       DRM_IOWR(0xB6, struct drm_mode_get_plane)
#define DMA_BUF_IOCTL_SYNC            _IOW('b', 0, struct dma_buf_sync)
#define DMA_BUF_SYNC_READ  1
#define DMA_BUF_SYNC_START 0
#define DMA_BUF_SYNC_END   4

static double now(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static int grab(int drm, uint32_t plane_id, uint8_t *out, uint32_t w, uint32_t h, int verbose) {
    struct drm_mode_get_plane gp; memset(&gp, 0, sizeof gp);
    gp.plane_id = plane_id;
    if (ioctl(drm, DRM_IOCTL_MODE_GETPLANE, &gp)) { perror("GETPLANE"); return -1; }
    if (!gp.fb_id) { fprintf(stderr, "plane %u has no framebuffer (screen off?)\n", plane_id); return -1; }

    struct drm_mode_fb_cmd fb; memset(&fb, 0, sizeof fb);
    fb.fb_id = gp.fb_id;
    if (ioctl(drm, DRM_IOCTL_MODE_GETFB, &fb)) { perror("GETFB"); return -1; }
    if (!fb.handle) { fprintf(stderr, "GETFB returned no handle (need root)\n"); return -1; }
    if (verbose)
        fprintf(stderr, "fb %u: %ux%u pitch=%u bpp=%u\n", fb.fb_id, fb.width, fb.height, fb.pitch, fb.bpp);

    int ret = -1;
    struct drm_prime_handle ph = { fb.handle, O_CLOEXEC, -1 };
    if (ioctl(drm, DRM_IOCTL_PRIME_HANDLE_TO_FD, &ph)) { perror("PRIME_HANDLE_TO_FD"); goto close_handle; }

    size_t size = (size_t)fb.pitch * fb.height;
    uint8_t *map = mmap(NULL, size, PROT_READ, MAP_SHARED, ph.fd, 0);
    if (map == MAP_FAILED) { perror("mmap"); goto close_fd; }

    struct dma_buf_sync s = { DMA_BUF_SYNC_START | DMA_BUF_SYNC_READ };
    ioctl(ph.fd, DMA_BUF_IOCTL_SYNC, &s);
    uint32_t cw = w, ch = h, bpp_bytes = fb.bpp / 8;
    if (cw > fb.width) cw = fb.width;
    if (ch > fb.height) ch = fb.height;
    memset(out, 0, (size_t)w * h * 2);
    for (uint32_t y = 0; y < ch; y++)
        memcpy(out + (size_t)y * w * 2, map + (size_t)y * fb.pitch, (size_t)cw * bpp_bytes);
    s.flags = DMA_BUF_SYNC_END | DMA_BUF_SYNC_READ;
    ioctl(ph.fd, DMA_BUF_IOCTL_SYNC, &s);

    munmap(map, size);
    ret = 0;
close_fd:
    close(ph.fd);
close_handle:;
    struct drm_gem_close gc = { fb.handle, 0 };
    ioctl(drm, DRM_IOCTL_GEM_CLOSE, &gc);
    return ret;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <out.raw> [seconds=10] [fps=30] [plane_id=76] [width=240] [height=320] [card=/dev/dri/card0]\n", argv[0]);
        return 1;
    }
    const char *outpath = argv[1];
    double secs   = argc > 2 ? atof(argv[2]) : 10;
    double fps    = argc > 3 ? atof(argv[3]) : 30;
    uint32_t plane = argc > 4 ? (uint32_t)atoi(argv[4]) : 76;
    uint32_t w    = argc > 5 ? (uint32_t)atoi(argv[5]) : 240;
    uint32_t h    = argc > 6 ? (uint32_t)atoi(argv[6]) : 320;
    const char *card = argc > 7 ? argv[7] : "/dev/dri/card0";

    int drm = open(card, O_RDWR | O_CLOEXEC);
    if (drm < 0) { perror(card); return 1; }
    struct drm_set_client_cap cap = { 2, 1 }; // universal planes
    ioctl(drm, DRM_IOCTL_SET_CLIENT_CAP, &cap);

    FILE *out = fopen(outpath, "wb");
    if (!out) { perror(outpath); return 1; }
    size_t fsz = (size_t)w * h * 2;
    uint8_t *frame = malloc(fsz);

    double start = now(), period = 1.0 / fps;
    long n = 0, target = (long)(secs * fps);
    fprintf(stderr, "recording %.1fs at %.0f fps from plane %u -> %s\n", secs, fps, plane, outpath);
    while (n < target) {
        if (grab(drm, plane, frame, w, h, n == 0)) {
            if (n == 0) return 1;
        }
        fwrite(frame, 1, fsz, out);
        n++;
        double next = start + n * period, t = now();
        if (next > t) {
            struct timespec ts = { (time_t)(next - t), (long)(((next - t) - (time_t)(next - t)) * 1e9) };
            nanosleep(&ts, NULL);
        }
    }
    double el = now() - start;
    fclose(out);
    fprintf(stderr, "done: %ld frames in %.2fs (%.1f fps effective)\n", n, el, n / el);
    return 0;
}

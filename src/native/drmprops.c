#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/stat.h>

#define D 'd'
struct drm_set_client_cap { uint64_t capability, value; };
struct drm_mode_card_res {
    uint64_t fb_id_ptr, crtc_id_ptr, connector_id_ptr, encoder_id_ptr;
    uint32_t count_fbs, count_crtcs, count_connectors, count_encoders;
    uint32_t min_width, max_width, min_height, max_height;
};
struct drm_mode_get_plane_res { uint64_t plane_id_ptr; uint32_t count_planes; };
struct drm_mode_obj_get_properties {
    uint64_t props_ptr, prop_values_ptr; uint32_t count_props, obj_id, obj_type;
};
struct drm_mode_get_property {
    uint64_t values_ptr, enum_blob_ptr; uint32_t prop_id, flags; char name[32];
    uint32_t count_values, count_enum_blobs;
};
struct drm_mode_property_enum { uint64_t value; char name[32]; };
struct drm_mode_get_blob { uint32_t blob_id, length; uint64_t data; };

#define IOC_SET_CAP   _IOW(D, 0x0d, struct drm_set_client_cap)
#define IOC_GETRES    _IOWR(D, 0xA0, struct drm_mode_card_res)
#define IOC_GETPROP   _IOWR(D, 0xAA, struct drm_mode_get_property)
#define IOC_GETBLOB   _IOWR(D, 0xAC, struct drm_mode_get_blob)
#define IOC_PLANERES  _IOWR(D, 0xB5, struct drm_mode_get_plane_res)
#define IOC_OBJPROPS  _IOWR(D, 0xB9, struct drm_mode_obj_get_properties)

#define P_RANGE 2
#define P_IMMUTABLE 4
#define P_ENUM 8
#define P_BLOB 16
#define P_BITMASK 32
#define P_EXT_MASK 0xffc0
#define P_OBJECT (1 << 6)
#define P_SRANGE (2 << 6)

#define T_CRTC 0xcccccccc
#define T_CONN 0xc0c0c0c0
#define T_PLANE 0xeeeeeeee

static int fd;
static const char *blobdir;

#define PTR(p) ((uint64_t)(uintptr_t)(p))

static void dump_blob(const char *obj, uint32_t id, const char *prop, uint32_t blob_id) {
    if (!blob_id) { printf(" (empty)\n"); return; }
    struct drm_mode_get_blob b = { blob_id, 0, 0 };
    if (ioctl(fd, IOC_GETBLOB, &b)) { printf(" (blob %u unreadable)\n", blob_id); return; }
    uint8_t *data = malloc(b.length ? b.length : 1);
    b.data = PTR(data);
    if (ioctl(fd, IOC_GETBLOB, &b)) { printf(" (blob %u read failed)\n", blob_id); free(data); return; }
    char path[512];
    snprintf(path, sizeof path, "%s/%s_%u_%s.bin", blobdir, obj, id, prop);
    for (char *c = path + strlen(blobdir) + 1; *c; c++) if (*c == ' ' || *c == '/') *c = '_';
    FILE *f = fopen(path, "wb");
    if (f) { fwrite(data, 1, b.length, f); fclose(f); }
    printf(" blob %u, %u bytes -> %s\n      ", blob_id, b.length, path);
    for (uint32_t i = 0; i < b.length && i < 64; i++) printf("%02x%s", data[i], (i % 16 == 15) ? "\n      " : " ");
    printf("%s\n", b.length > 64 ? "..." : "");
    free(data);
}

static void dump_obj(const char *kind, uint32_t id, uint32_t type) {
    struct drm_mode_obj_get_properties op = {0};
    op.obj_id = id; op.obj_type = type;
    if (ioctl(fd, IOC_OBJPROPS, &op)) { printf("%s %u: cannot list properties\n", kind, id); return; }
    uint32_t n = op.count_props;
    uint32_t *ids = calloc(n + 1, 4); uint64_t *vals = calloc(n + 1, 8);
    op.props_ptr = PTR(ids); op.prop_values_ptr = PTR(vals);
    ioctl(fd, IOC_OBJPROPS, &op);
    printf("\n=== %s %u (%u properties) ===\n", kind, id, n);
    for (uint32_t i = 0; i < n; i++) {
        struct drm_mode_get_property p; memset(&p, 0, sizeof p);
        p.prop_id = ids[i];
        if (ioctl(fd, IOC_GETPROP, &p)) continue;
        uint32_t nv = p.count_values, ne = p.count_enum_blobs;
        uint64_t *pv = calloc(nv + 1, 8);
        struct drm_mode_property_enum *pe = calloc(ne + 1, sizeof *pe);
        p.values_ptr = PTR(pv); p.enum_blob_ptr = PTR(pe);
        ioctl(fd, IOC_GETPROP, &p);
        uint64_t v = vals[i];
        uint32_t ext = p.flags & P_EXT_MASK;
        printf("  %-32s", p.name);
        if (p.flags & P_BLOB) {
            printf(" [blob]");
            dump_blob(kind, id, p.name, (uint32_t)v);
        } else if (p.flags & (P_ENUM | P_BITMASK)) {
            printf(" [%s] = %llu", (p.flags & P_ENUM) ? "enum" : "bitmask", (unsigned long long)v);
            for (uint32_t k = 0; k < ne; k++) {
                int on = (p.flags & P_ENUM) ? pe[k].value == v : ((v >> pe[k].value) & 1);
                if (on) printf(" %s", pe[k].name);
            }
            printf("\n");
        } else if (p.flags & P_RANGE) {
            printf(" [range %llu..%llu] = %llu\n", (unsigned long long)pv[0],
                   (unsigned long long)(nv > 1 ? pv[1] : 0), (unsigned long long)v);
        } else if (ext == P_SRANGE) {
            printf(" [srange] = %lld\n", (long long)v);
        } else if (ext == P_OBJECT) {
            printf(" [object] = %llu\n", (unsigned long long)v);
        } else {
            printf(" [flags 0x%x] = %llu\n", p.flags, (unsigned long long)v);
        }
        free(pv); free(pe);
    }
    free(ids); free(vals);
}

int main(int argc, char **argv) {
    const char *card = argc > 1 ? argv[1] : "/dev/dri/card0";
    blobdir = argc > 2 ? argv[2] : "/data/local/tmp/drmblobs";
    mkdir(blobdir, 0755);
    fd = open(card, O_RDWR | O_CLOEXEC);
    if (fd < 0) { perror(card); return 1; }
    struct drm_set_client_cap c = { 2, 1 }; ioctl(fd, IOC_SET_CAP, &c); // universal planes
    c.capability = 3; ioctl(fd, IOC_SET_CAP, &c); // atomic

    struct drm_mode_card_res r; memset(&r, 0, sizeof r);
    if (ioctl(fd, IOC_GETRES, &r)) { perror("GETRESOURCES"); return 1; }
    uint32_t *crtcs = calloc(r.count_crtcs + 1, 4), *conns = calloc(r.count_connectors + 1, 4);
    uint32_t nc = r.count_crtcs, nn = r.count_connectors;
    memset(&r, 0, sizeof r);
    r.count_crtcs = nc; r.count_connectors = nn;
    r.crtc_id_ptr = PTR(crtcs); r.connector_id_ptr = PTR(conns);
    ioctl(fd, IOC_GETRES, &r);

    struct drm_mode_get_plane_res pr = {0};
    ioctl(fd, IOC_PLANERES, &pr);
    uint32_t np = pr.count_planes, *planes = calloc(np + 1, 4);
    pr.plane_id_ptr = PTR(planes); ioctl(fd, IOC_PLANERES, &pr);

    printf("%s: %u crtcs, %u connectors, %u planes. Blobs saved to %s\n", card, nc, nn, np, blobdir);
    for (uint32_t i = 0; i < nc; i++) dump_obj("crtc", crtcs[i], T_CRTC);
    for (uint32_t i = 0; i < nn; i++) dump_obj("connector", conns[i], T_CONN);
    for (uint32_t i = 0; i < np; i++) dump_obj("plane", planes[i], T_PLANE);
    return 0;
}

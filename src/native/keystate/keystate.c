#include <dirent.h>
#include <fcntl.h>
#include <linux/input.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define BYTES (KEY_MAX / 8 + 1)
#define MAX_DEVS 32

static int is_held(const unsigned char *held, long code)
{
    return (held[code / 8] >> (code % 8)) & 1;
}

int main(int argc, char **argv)
{
    unsigned char held[BYTES] = {0};
    int fds[MAX_DEVS], n = 0;

    for (int i = 1; i < argc; i++) {
        char *end;
        long code = strtol(argv[i], &end, 10);
        if (*argv[i] == '\0' || *end != '\0' || code < 0 || code > KEY_MAX) {
            fprintf(stderr, "usage: keystate [CODE...]\n");
            return 2;
        }
    }

    DIR *dir = opendir("/dev/input");
    if (!dir) {
        perror("/dev/input");
        return 2;
    }
    struct dirent *e;
    while ((e = readdir(dir)) && n < MAX_DEVS) {
        char path[64];
        if (strncmp(e->d_name, "event", 5) != 0)
            continue;
        snprintf(path, sizeof path, "/dev/input/%s", e->d_name);
        int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
        if (fd >= 0)
            fds[n++] = fd;
    }
    closedir(dir);

    // a keypad nobody has opened yet scans its keys when it is opened
    usleep(50 * 1000);

    for (int i = 0; i < n; i++) {
        unsigned char bits[BYTES] = {0};
        if (ioctl(fds[i], EVIOCGKEY(sizeof bits), bits) >= 0)
            for (int b = 0; b < BYTES; b++)
                held[b] |= bits[b];
        close(fds[i]);
    }

    if (argc == 1) {
        for (long code = 0; code <= KEY_MAX; code++)
            if (is_held(held, code))
                printf("%ld\n", code);
        return 0;
    }
    for (int i = 1; i < argc; i++)
        if (!is_held(held, strtol(argv[i], NULL, 10)))
            return 1;
    return 0;
}

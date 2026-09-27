#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define START_TIMEOUT_MS 20000
#define STOP_TIMEOUT_MS  (15 * 60 * 1000)

static int port = 8322;
static const char *origin_allowed = "http://callscreen.localhost";
static const char *dir = "/data/local/tmp/callrec";
static char *run_argv[32];
static pid_t child;

static void logf_(const char *fmt, ...) {
    char ts[32];
    time_t now = time(NULL);
    strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", localtime(&now));
    printf("%s ", ts);
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    putchar('\n');
    fflush(stdout);
}

static long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
}

static void sleep_ms(int ms) {
    struct timespec t = {ms / 1000, (ms % 1000) * 1000000L};
    nanosleep(&t, NULL);
}

static void path_of(char *out, size_t n, const char *name) {
    snprintf(out, n, "%s/%s", dir, name);
}

static void remove_file(const char *name) {
    char p[512];
    path_of(p, sizeof p, name);
    unlink(p);
}

static void read_state(char *buf, size_t n) {
    char p[512];
    path_of(p, sizeof p, "state");
    buf[0] = 0;
    int fd = open(p, O_RDONLY);
    if (fd < 0) return;
    ssize_t r = read(fd, buf, n - 1);
    close(fd);
    if (r < 0) r = 0;
    buf[r] = 0;
    buf[strcspn(buf, "\r\n")] = 0;
}

static int child_alive(void) {
    if (child > 0) {
        int st;
        pid_t r = waitpid(child, &st, WNOHANG);
        if (r == child || (r < 0 && errno == ECHILD)) {
            logf_("recorder (pid %d) exited", (int) child);
            child = 0;
        }
    }
    return child > 0;
}

static void stop_child(int ms) {
    if (!child_alive()) return;
    char p[512];
    path_of(p, sizeof p, "stop");
    close(open(p, O_WRONLY | O_CREAT, 0600));
    long end = now_ms() + ms;
    while (child_alive() && now_ms() < end) sleep_ms(100);
    if (child_alive()) {
        logf_("recorder (pid %d) didn't stop, killing it", (int) child);
        kill(-child, SIGKILL);
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
        child = 0;
    }
}

static void clear_files(void) {
    remove_file("state");
    remove_file("state.tmp");
    remove_file("stop");
    remove_file("rec.wav");
    remove_file("rec.m4a");
}

static void json_escape(char *out, size_t n, const char *in) {
    size_t o = 0;
    for (; *in && o + 7 < n; in++) {
        unsigned char c = (unsigned char) *in;
        if (c == '"' || c == '\\') {
            out[o++] = '\\';
            out[o++] = c;
        } else if (c < 0x20) {
            o += snprintf(out + o, n - o, "\\u%04x", c);
        } else {
            out[o++] = c;
        }
    }
    out[o] = 0;
}

static void write_all(int fd, const char *b, size_t n) {
    while (n > 0) {
        ssize_t w = write(fd, b, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            return;
        }
        b += w;
        n -= w;
    }
}

static void head(int fd, int code, const char *type, long long len, const char *origin) {
    const char *reason = code == 200 ? "OK" : code == 204 ? "No Content" : code == 403 ? "Forbidden"
                       : code == 404 ? "Not Found" : code == 409 ? "Conflict" : "Error";
    char h[1024];
    int n = snprintf(h, sizeof h,
                     "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %lld\r\n"
                     "Cache-Control: no-store\r\nConnection: close\r\n",
                     code, reason, type, len);
    if (origin[0]) {
        n += snprintf(h + n, sizeof h - n,
                      "Access-Control-Allow-Origin: %s\r\nAccess-Control-Allow-Methods: GET, POST\r\n"
                      "Access-Control-Allow-Headers: Content-Type\r\n", origin);
    }
    n += snprintf(h + n, sizeof h - n, "\r\n");
    write_all(fd, h, n);
}

static void reply(int fd, int code, const char *origin, const char *fmt, ...) {
    char body[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(body, sizeof body, fmt, ap);
    va_end(ap);
    head(fd, code, "application/json", (long long) strlen(body), origin);
    write_all(fd, body, strlen(body));
}

static void reply_error(int fd, int code, const char *origin, const char *msg) {
    char e[1024];
    json_escape(e, sizeof e, msg);
    reply(fd, code, origin, "{\"error\":\"%s\"}", e);
}

static void do_start(int fd, const char *origin) {
    if (child_alive()) {
        logf_("start: a recorder is still running, stopping it first");
        stop_child(5000);
    }
    mkdir(dir, 0700);
    chmod(dir, 0700);
    clear_files();

    char logpath[512];
    path_of(logpath, sizeof logpath, "log");
    pid_t pid = fork();
    if (pid < 0) {
        reply_error(fd, 500, origin, "fork failed");
        return;
    }
    if (pid == 0) {
        setsid();
        int lf = open(logpath, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        int nul = open("/dev/null", O_RDONLY);
        if (nul >= 0) dup2(nul, 0);
        if (lf >= 0) {
            dup2(lf, 1);
            dup2(lf, 2);
        }
        for (int i = 3; i < 256; i++) close(i);
        execv(run_argv[0], run_argv);
        fprintf(stderr, "exec %s: %s\n", run_argv[0], strerror(errno));
        _exit(127);
    }
    child = pid;
    logf_("start: recorder pid %d", (int) pid);

    char state[512];
    long end = now_ms() + START_TIMEOUT_MS;
    for (;;) {
        read_state(state, sizeof state);
        if (strcmp(state, "recording") == 0) {
            reply(fd, 200, origin, "{\"ok\":true}");
            return;
        }
        if (strncmp(state, "error", 5) == 0) {
            logf_("start: %s", state);
            child_alive();
            reply_error(fd, 500, origin, state[5] ? state + 6 : "recorder failed");
            return;
        }
        if (!child_alive()) {
            logf_("start: recorder exited before recording (see %s)", logpath);
            reply_error(fd, 500, origin, "the recorder exited before recording; see the log");
            return;
        }
        if (now_ms() > end) {
            logf_("start: timed out");
            stop_child(0);
            reply_error(fd, 500, origin, "the recorder didn't start in time");
            return;
        }
        sleep_ms(100);
    }
}

static void reply_done(int fd, const char *origin, const char *state) {
    char file[128] = "", type[64] = "";
    long seconds = 0, peak = 0;
    if (sscanf(state, "done %127s %63s %ld %ld", file, type, &seconds, &peak) < 2
        || strchr(file, '/')) {
        reply_error(fd, 500, origin, "unexpected recorder state");
        return;
    }
    const char *ext = strrchr(file, '.');
    reply(fd, 200, origin,
          "{\"ok\":true,\"file\":\"%s\",\"type\":\"%s\",\"ext\":\"%s\",\"seconds\":%ld,\"peak\":%ld}",
          file, type, ext ? ext + 1 : "", seconds, peak);
}

static void do_stop(int fd, const char *origin) {
    char state[512];
    if (!child_alive()) {
        read_state(state, sizeof state);
        if (strncmp(state, "done ", 5) == 0) {
            reply_done(fd, origin, state);
        } else {
            reply_error(fd, 409, origin, "not recording");
        }
        return;
    }
    logf_("stop: finishing");
    stop_child(STOP_TIMEOUT_MS);
    read_state(state, sizeof state);
    logf_("stop: %s", state);
    if (strncmp(state, "done ", 5) == 0) {
        reply_done(fd, origin, state);
    } else {
        reply_error(fd, 500, origin, state[0] ? state : "the recorder exited without a file");
    }
}

static void do_file(int fd, const char *origin) {
    char state[512], file[128] = "", type[64] = "";
    read_state(state, sizeof state);
    if (child_alive() || sscanf(state, "done %127s %63s", file, type) != 2 || strchr(file, '/')) {
        reply_error(fd, 404, origin, "no finished recording");
        return;
    }
    char p[512];
    path_of(p, sizeof p, file);
    int f = open(p, O_RDONLY);
    struct stat st;
    if (f < 0 || fstat(f, &st) < 0) {
        if (f >= 0) close(f);
        reply_error(fd, 404, origin, "the recording is gone");
        return;
    }
    head(fd, 200, type, (long long) st.st_size, origin);
    char buf[65536];
    ssize_t r;
    while ((r = read(f, buf, sizeof buf)) > 0) write_all(fd, buf, (size_t) r);
    close(f);
    logf_("file: sent %s (%lld bytes)", file, (long long) st.st_size);
}

static void handle(int fd) {
    struct timeval tv = {5, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    char req[8192];
    size_t got = 0;
    while (got < sizeof req - 1) {
        ssize_t r = read(fd, req + got, sizeof req - 1 - got);
        if (r <= 0) break;
        got += (size_t) r;
        req[got] = 0;
        if (strstr(req, "\r\n\r\n")) break;
    }
    req[got] = 0;
    char method[16] = "", path[256] = "";
    if (sscanf(req, "%15s %255s", method, path) != 2) return;
    path[strcspn(path, "?")] = 0;

    char origin[256] = "";
    for (char *line = strstr(req, "\r\n"); line; line = strstr(line + 2, "\r\n")) {
        if (strncasecmp(line + 2, "Origin:", 7) == 0) {
            const char *v = line + 9;
            while (*v == ' ') v++;
            size_t n = strcspn(v, "\r\n");
            if (n >= sizeof origin) n = sizeof origin - 1;
            memcpy(origin, v, n);
            origin[n] = 0;
            break;
        }
    }
    if (origin[0] && strcmp(origin, origin_allowed) != 0) {
        logf_("refused %s %s from %s", method, path, origin);
        reply_error(fd, 403, "", "origin not allowed");
        return;
    }

    if (strcmp(method, "OPTIONS") == 0) {
        head(fd, 204, "text/plain", 0, origin);
    } else if (strcmp(method, "POST") == 0 && strcmp(path, "/start") == 0) {
        do_start(fd, origin);
    } else if (strcmp(method, "POST") == 0 && strcmp(path, "/stop") == 0) {
        do_stop(fd, origin);
    } else if (strcmp(method, "GET") == 0 && strcmp(path, "/file") == 0) {
        do_file(fd, origin);
    } else if (strcmp(method, "POST") == 0 && strcmp(path, "/clear") == 0) {
        if (child_alive()) {
            reply_error(fd, 409, origin, "recording");
        } else {
            clear_files();
            reply(fd, 200, origin, "{\"ok\":true}");
        }
    } else if (strcmp(method, "GET") == 0 && strcmp(path, "/status") == 0) {
        char state[512], e[600];
        int alive = child_alive();
        read_state(state, sizeof state);
        json_escape(e, sizeof e, state);
        reply(fd, 200, origin, "{\"recording\":%s,\"state\":\"%s\"}", alive ? "true" : "false", e);
    } else {
        reply_error(fd, 404, origin, "unknown request");
    }
}

static void usage(void) {
    fprintf(stderr, "usage: callrecd [--port N] [--origin URL] [--dir DIR] --run \"COMMAND\"\n");
    exit(2);
}

int main(int argc, char **argv) {
    const char *run = NULL;
    for (int i = 1; i < argc; i++) {
        if (i + 1 >= argc) usage();
        if (strcmp(argv[i], "--port") == 0) port = atoi(argv[++i]);
        else if (strcmp(argv[i], "--origin") == 0) origin_allowed = argv[++i];
        else if (strcmp(argv[i], "--dir") == 0) dir = argv[++i];
        else if (strcmp(argv[i], "--run") == 0) run = argv[++i];
        else usage();
    }
    if (!run) usage();
    int n = 0;
    for (char *tok = strtok(strdup(run), " "); tok && n < 30; tok = strtok(NULL, " ")) {
        run_argv[n++] = tok;
    }
    run_argv[n++] = (char *) dir;
    run_argv[n] = NULL;

    signal(SIGPIPE, SIG_IGN);
    int s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int one = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a = {0};
    a.sin_family = AF_INET;
    a.sin_port = htons((unsigned short) port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(s, (struct sockaddr *) &a, sizeof a) < 0 || listen(s, 8) < 0) {
        logf_("can't listen on 127.0.0.1:%d: %s", port, strerror(errno));
        return 1;
    }
    logf_("listening on 127.0.0.1:%d for %s; recordings in %s", port, origin_allowed, dir);
    for (;;) {
        int c = accept4(s, NULL, NULL, SOCK_CLOEXEC);
        if (c < 0) {
            if (errno != EINTR) sleep_ms(100);
            continue;
        }
        handle(c);
        close(c);
        child_alive();
    }
}

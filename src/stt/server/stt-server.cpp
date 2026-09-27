#include "whisper.h"

#include <arpa/inet.h>
#include <grp.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

struct Config {
    std::string model;
    std::string host = "127.0.0.1";
    int port = 8321;
    int threads = 4;
    int idle_s = 15;
    int uid = -1;
    int gid = -1;
    bool short_ctx = true;
    int min_ctx = 320;
    std::string lang = "en";
    std::vector<std::string> origins = {"http://dictate.localhost"};
    std::string file;
    int bench = 1;
    bool verbose = false;
};

Config g_cfg;
std::mutex g_model_mu;
whisper_context * g_ctx = nullptr;
std::atomic<bool> g_loaded{false};
std::atomic<bool> g_warm{false};
std::atomic<long> g_last_use_ms{0};
std::atomic<unsigned> g_latest_job{0};

constexpr size_t kMaxHeader = 16 * 1024;
constexpr int kSampleRate = WHISPER_SAMPLE_RATE;
constexpr size_t kMaxSeconds = 60;
constexpr size_t kMaxBody = kMaxSeconds * kSampleRate * 2 + 1024;

void logf(const char * fmt, ...) {
    char ts[32];
    time_t t = time(nullptr);
    strftime(ts, sizeof ts, "%m-%d %H:%M:%SZ", gmtime(&t));
    fprintf(stderr, "%s ", ts);
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    fflush(stderr);
}

void whisper_log_cb(ggml_log_level level, const char * text, void *) {
    if (g_cfg.verbose || level == GGML_LOG_LEVEL_ERROR) {
        fputs(text, stderr);
    }
}

long ms_since(std::chrono::steady_clock::time_point t0) {
    return (long) std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t0).count();
}

long now_ms() {
    return (long) std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

void touch() {
    g_last_use_ms = now_ms();
}

bool ensure_model() {
    touch();
    if (g_ctx) {
        return true;
    }
    auto t0 = std::chrono::steady_clock::now();
    whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = false;
    cp.flash_attn = true;
    g_ctx = whisper_init_from_file_with_params(g_cfg.model.c_str(), cp);
    if (!g_ctx) {
        logf("failed to load model %s", g_cfg.model.c_str());
        return false;
    }
    g_loaded = true;
    logf("model loaded in %ld ms", ms_since(t0));
    return true;
}

void unload_model() {
    if (g_ctx) {
        whisper_free(g_ctx);
        g_ctx = nullptr;
        g_loaded = false;
        g_warm = false;
        logf("model unloaded (idle)");
    }
}

std::string clean_text(const std::string & in) {
    std::string out;
    int depth = 0;
    for (char c : in) {
        if (c == '[' || c == '(') { depth++; continue; }
        if ((c == ']' || c == ')') && depth > 0) { depth--; continue; }
        if (depth == 0) out += c;
    }
    std::string squeezed;
    for (char c : out) {
        if (c == '\n' || c == '\t') c = ' ';
        if (c == ' ' && (squeezed.empty() || squeezed.back() == ' ')) continue;
        squeezed += c;
    }
    while (!squeezed.empty() && squeezed.back() == ' ') squeezed.pop_back();
    return squeezed;
}

struct AbortCheck {
    std::chrono::steady_clock::time_point deadline;
    std::chrono::steady_clock::time_point next_poll{};
    int client_fd = -1;
    unsigned job = 0;
    const char * why = nullptr;
};

bool should_abort(void * data) {
    auto * a = (AbortCheck *) data;
    const auto now = std::chrono::steady_clock::now();
    if (now > a->deadline) {
        a->why = "took too long";
        return true;
    }
    if (a->job && a->job != g_latest_job) {
        a->why = "superseded by a newer request";
        return true;
    }
    if (now < a->next_poll) {
        return false;
    }
    a->next_poll = now + std::chrono::milliseconds(50);
    if (a->client_fd >= 0) {
        char c;
        const ssize_t r = recv(a->client_fd, &c, 1, MSG_PEEK | MSG_DONTWAIT);
        if (r == 0 || (r < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) {
            a->why = "client went away";
            return true;
        }
    }
    return false;
}

bool transcribe(const std::vector<float> & pcm, std::string & text, std::string & err,
                int client_fd = -1, unsigned job = 0) {
    if (!ensure_model()) {
        err = "model failed to load";
        return false;
    }
    const float seconds = (float) pcm.size() / kSampleRate;
    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.n_threads = g_cfg.threads;
    p.language = g_cfg.lang.c_str();
    p.translate = false;
    p.no_timestamps = true;
    p.no_context = true;
    p.single_segment = false;
    p.suppress_blank = true;
    p.suppress_nst = true;
    p.print_progress = false;
    p.print_realtime = false;
    p.print_special = false;
    p.print_timestamps = false;

    p.temperature_inc = 0.0f;
    p.max_tokens = (int) (seconds * 10) + 16;

    if (g_cfg.short_ctx) {
        int frames = (int) (seconds * 50) + 128;
        if (frames < g_cfg.min_ctx) frames = g_cfg.min_ctx;
        p.audio_ctx = frames < 1500 ? frames : 0;
    }

    AbortCheck check;
    check.deadline = std::chrono::steady_clock::now() +
                     std::chrono::milliseconds((long) (5000 + seconds * 1000));
    check.client_fd = client_fd;
    check.job = job;
    p.abort_callback = should_abort;
    p.abort_callback_user_data = &check;

    if (whisper_full(g_ctx, p, pcm.data(), (int) pcm.size()) != 0) {
        err = check.why ? check.why : "whisper_full failed";
        touch();
        return false;
    }
    std::string raw;
    const int n = whisper_full_n_segments(g_ctx);
    for (int i = 0; i < n; i++) {
        raw += whisper_full_get_segment_text(g_ctx, i);
    }
    text = clean_text(raw);
    g_warm = true;
    touch();
    return true;
}

bool warmup(int client_fd = -1) {
    if (g_warm) {
        return ensure_model();
    }
    auto t0 = std::chrono::steady_clock::now();
    std::vector<float> silence(kSampleRate, 0.0f);
    std::string text, err;
    if (!transcribe(silence, text, err, client_fd)) {
        logf("warmup failed: %s", err.c_str());
        return false;
    }
    logf("warmed up in %ld ms", ms_since(t0));
    return true;
}

bool decode_audio(const std::string & body, std::vector<float> & pcm, std::string & err) {
    const uint8_t * d = (const uint8_t *) body.data();
    size_t off = 0, len = body.size();

    if (len >= 12 && memcmp(d, "RIFF", 4) == 0 && memcmp(d + 8, "WAVE", 4) == 0) {
        size_t pos = 12;
        bool have_fmt = false;
        while (pos + 8 <= len) {
            uint32_t sz;
            memcpy(&sz, d + pos + 4, 4);
            if (memcmp(d + pos, "fmt ", 4) == 0 && sz >= 16 && pos + 8 + 16 <= len) {
                uint16_t fmt, ch, bits;
                uint32_t rate;
                memcpy(&fmt, d + pos + 8, 2);
                memcpy(&ch, d + pos + 10, 2);
                memcpy(&rate, d + pos + 12, 4);
                memcpy(&bits, d + pos + 22, 2);
                if (fmt != 1 || ch != 1 || rate != (uint32_t) kSampleRate || bits != 16) {
                    err = "WAV must be PCM 16-bit mono 16000 Hz";
                    return false;
                }
                have_fmt = true;
            } else if (memcmp(d + pos, "data", 4) == 0) {
                if (!have_fmt) {
                    err = "WAV data chunk before fmt chunk";
                    return false;
                }
                off = pos + 8;
                len = sz < len - off ? off + sz : len;
                break;
            }
            pos += 8 + sz + (sz & 1);
        }
        if (off == 0) {
            err = "WAV has no data chunk";
            return false;
        }
    }

    const size_t n = (len - off) / 2;
    if (n < (size_t) kSampleRate / 4) {
        err = "audio too short";
        return false;
    }
    pcm.resize(n);
    for (size_t i = 0; i < n; i++) {
        int16_t s;
        memcpy(&s, d + off + i * 2, 2);
        pcm[i] = s / 32768.0f;
    }
    return true;
}

std::string json_escape(const std::string & s) {
    std::string o;
    for (unsigned char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) {
                    char b[8];
                    snprintf(b, sizeof b, "\\u%04x", c);
                    o += b;
                } else {
                    o += (char) c;
                }
        }
    }
    return o;
}

bool send_all(int fd, const std::string & s) {
    size_t sent = 0;
    while (sent < s.size()) {
        ssize_t r = send(fd, s.data() + sent, s.size() - sent, MSG_NOSIGNAL);
        if (r <= 0) {
            if (r < 0 && errno == EINTR) continue;
            return false;
        }
        sent += (size_t) r;
    }
    return true;
}

void respond(int fd, int status, const std::string & origin, const std::string & body) {
    const char * reason = status == 200 ? "OK" : status == 204 ? "No Content"
                        : status == 400 ? "Bad Request" : status == 403 ? "Forbidden"
                        : status == 404 ? "Not Found" : status == 413 ? "Payload Too Large"
                        : "Internal Server Error";
    std::string h = "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\n";
    if (!origin.empty()) {
        h += "Access-Control-Allow-Origin: " + origin + "\r\n";
        h += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n";
        h += "Access-Control-Allow-Headers: Content-Type\r\n";
        h += "Access-Control-Max-Age: 86400\r\n";
        h += "Vary: Origin\r\n";
    }
    if (status != 204) {
        h += "Content-Type: application/json\r\n";
    }
    h += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    h += "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
    send_all(fd, h + body);
}

std::string header_value(const std::string & head, const char * name) {
    const size_t nlen = strlen(name);
    size_t pos = head.find("\r\n");
    while (pos != std::string::npos && pos + 2 < head.size()) {
        size_t line = pos + 2;
        size_t end = head.find("\r\n", line);
        if (end == std::string::npos) end = head.size();
        if (end - line > nlen && head[line + nlen] == ':' &&
            strncasecmp(head.c_str() + line, name, nlen) == 0) {
            size_t v = line + nlen + 1;
            while (v < end && head[v] == ' ') v++;
            return head.substr(v, end - v);
        }
        pos = end;
    }
    return "";
}

bool origin_allowed(const std::string & origin) {
    if (origin.empty()) return true;
    for (const auto & o : g_cfg.origins) {
        if (o == "*" || o == origin) return true;
    }
    return false;
}

void run_job(int fd, unsigned job, const std::string & origin, const std::vector<float> & pcm) {
    const long audio_ms = (long) (pcm.size() * 1000 / kSampleRate);
    std::lock_guard<std::mutex> lock(g_model_mu);
    std::string err, text;
    if (job != g_latest_job) {
        logf("dropped %ld ms of audio: superseded before it started", audio_ms);
        respond(fd, 500, origin, "{\"error\":\"superseded by a newer request\"}");
        return;
    }
    auto t0 = std::chrono::steady_clock::now();
    if (!transcribe(pcm, text, err, fd, job)) {
        logf("abandoned %ld ms of audio after %ld ms: %s", audio_ms, ms_since(t0), err.c_str());
        respond(fd, 500, origin, "{\"error\":\"" + json_escape(err) + "\"}");
        return;
    }
    const long ms = ms_since(t0);
    logf("transcribed %ld ms of audio in %ld ms (%zu chars)", audio_ms, ms, text.size());
    respond(fd, 200, origin, "{\"text\":\"" + json_escape(text) + "\",\"audio_ms\":" +
            std::to_string(audio_ms) + ",\"ms\":" + std::to_string(ms) + "}");
}

bool handle_client(int fd) {
    timeval tv{5, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);

    std::string buf;
    size_t head_end;
    char tmp[16384];
    while ((head_end = buf.find("\r\n\r\n")) == std::string::npos) {
        if (buf.size() > kMaxHeader) return false;
        ssize_t r = recv(fd, tmp, sizeof tmp, 0);
        if (r <= 0) return false;
        buf.append(tmp, (size_t) r);
    }
    const std::string head = buf.substr(0, head_end);
    std::string body = buf.substr(head_end + 4);

    const size_t sp1 = head.find(' ');
    const size_t sp2 = head.find(' ', sp1 + 1);
    if (sp1 == std::string::npos || sp2 == std::string::npos) return false;
    const std::string method = head.substr(0, sp1);
    std::string path = head.substr(sp1 + 1, sp2 - sp1 - 1);
    path = path.substr(0, path.find('?'));

    const std::string origin = header_value(head, "Origin");
    if (!origin_allowed(origin)) {
        logf("rejected origin %s", origin.c_str());
        respond(fd, 403, "", "{\"error\":\"origin not allowed\"}");
        return false;
    }

    if (method == "OPTIONS") {
        respond(fd, 204, origin, "");
        return false;
    }
    if (method == "GET" && path == "/health") {
        respond(fd, 200, origin, std::string("{\"ok\":true,\"loaded\":") + (g_loaded ? "true" : "false") +
                ",\"model\":\"" + json_escape(g_cfg.model) + "\",\"threads\":" +
                std::to_string(g_cfg.threads) + ",\"version\":\"" + whisper_version() + "\"}");
        return false;
    }
    if (method == "POST" && path == "/warmup") {
        bool ok;
        if (g_warm && g_loaded) {
            touch();
            ok = true;
        } else {
            std::lock_guard<std::mutex> lock(g_model_mu);
            ok = warmup(fd);
        }
        respond(fd, ok ? 200 : 500, origin, ok ? "{\"ok\":true}" : "{\"error\":\"model failed to load\"}");
        return false;
    }
    if (method == "POST" && path == "/transcribe") {
        const std::string cl = header_value(head, "Content-Length");
        const size_t want = cl.empty() ? 0 : strtoul(cl.c_str(), nullptr, 10);
        if (want == 0) {
            respond(fd, 400, origin, "{\"error\":\"Content-Length required\"}");
            return false;
        }
        if (want > kMaxBody) {
            respond(fd, 413, origin, "{\"error\":\"audio longer than 60 s\"}");
            return false;
        }
        while (body.size() < want) {
            ssize_t r = recv(fd, tmp, sizeof tmp, 0);
            if (r <= 0) return false;
            body.append(tmp, (size_t) r);
        }
        body.resize(want);

        std::vector<float> pcm;
        std::string err;
        if (!decode_audio(body, pcm, err)) {
            respond(fd, 400, origin, "{\"error\":\"" + json_escape(err) + "\"}");
            return false;
        }
        const unsigned job = ++g_latest_job;
        std::thread([fd, job, origin, pcm = std::move(pcm)]() {
            run_job(fd, job, origin, pcm);
            close(fd);
        }).detach();
        return true;
    }
    respond(fd, 404, origin, "{\"error\":\"not found\"}");
    return false;
}

bool drop_privileges() {
    if (g_cfg.uid < 0) return true;
    const gid_t gid = (gid_t) (g_cfg.gid >= 0 ? g_cfg.gid : g_cfg.uid);
    if (setgroups(0, nullptr) != 0 || setgid(gid) != 0 || setuid((uid_t) g_cfg.uid) != 0) {
        logf("failed to drop privileges to %d:%d: %s", g_cfg.uid, (int) gid, strerror(errno));
        return false;
    }
    return true;
}

int run_file() {
    FILE * f = fopen(g_cfg.file.c_str(), "rb");
    if (!f) {
        logf("cannot open %s", g_cfg.file.c_str());
        return 1;
    }
    std::string body;
    char tmp[65536];
    size_t r;
    while ((r = fread(tmp, 1, sizeof tmp, f)) > 0) body.append(tmp, r);
    fclose(f);

    std::vector<float> pcm;
    std::string err, text;
    if (!decode_audio(body, pcm, err)) {
        logf("%s", err.c_str());
        return 1;
    }
    auto t0 = std::chrono::steady_clock::now();
    if (!ensure_model()) return 1;
    logf("load: %ld ms", ms_since(t0));
    for (int i = 0; i < g_cfg.bench; i++) {
        t0 = std::chrono::steady_clock::now();
        if (!transcribe(pcm, text, err)) {
            logf("%s", err.c_str());
            return 1;
        }
        logf("run %d: %zu ms audio -> %ld ms, threads=%d short_ctx=%d", i + 1,
             pcm.size() * 1000 / kSampleRate, ms_since(t0), g_cfg.threads, (int) g_cfg.short_ctx);
    }
    printf("%s\n", text.c_str());
    unload_model();
    return 0;
}

int run_server() {
    int s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    int one = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t) g_cfg.port);
    if (inet_pton(AF_INET, g_cfg.host.c_str(), &addr.sin_addr) != 1) {
        logf("bad --host %s", g_cfg.host.c_str());
        return 1;
    }
    if (bind(s, (sockaddr *) &addr, sizeof addr) != 0 || listen(s, 4) != 0) {
        logf("cannot listen on %s:%d: %s", g_cfg.host.c_str(), g_cfg.port, strerror(errno));
        return 1;
    }
    if (!drop_privileges()) return 1;
    if (access(g_cfg.model.c_str(), R_OK) != 0) {
        logf("model %s not readable: %s", g_cfg.model.c_str(), strerror(errno));
        return 1;
    }
    logf("listening on %s:%d (model %s, %d threads, idle unload %ds)", g_cfg.host.c_str(),
         g_cfg.port, g_cfg.model.c_str(), g_cfg.threads, g_cfg.idle_s);

    for (;;) {
        pollfd pfd{s, POLLIN, 0};
        int timeout = -1;
        if (g_loaded) {
            const long left = (long) g_cfg.idle_s * 1000 - (now_ms() - g_last_use_ms);
            timeout = left > 0 ? (int) left + 1 : 500;
        }
        const int pr = poll(&pfd, 1, timeout);
        if (pr < 0 && errno != EINTR) {
            logf("poll: %s", strerror(errno));
            return 1;
        }
        if (pr > 0) {
            int c = accept4(s, nullptr, nullptr, SOCK_CLOEXEC);
            if (c >= 0) {
                setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
                if (!handle_client(c)) {
                    close(c);
                }
            }
        }
        if (g_loaded && now_ms() - g_last_use_ms >= (long) g_cfg.idle_s * 1000) {
            std::unique_lock<std::mutex> lock(g_model_mu, std::try_to_lock);
            if (lock.owns_lock()) {
                unload_model();
            }
        }
    }
}

void usage(const char * argv0) {
    fprintf(stderr,
        "usage: %s --model FILE [options]\n"
        "  --host ADDR       listen address (default 127.0.0.1)\n"
        "  --port N          listen port (default 8321)\n"
        "  --threads N       inference threads (default 4)\n"
        "  --idle SECONDS    free the model after this long unused (default 15)\n"
        "  --lang CODE       spoken language (default en)\n"
        "  --origin URL      allowed browser Origin, repeatable, '*' = any\n"
        "                    (default http://dictate.localhost)\n"
        "  --uid N [--gid N] drop root to this uid/gid after binding\n"
        "  --full-ctx        always encode the full 30 s window (slower)\n"
        "  --min-ctx N       smallest encoder window in 20 ms frames (default 320)\n"
        "  --file WAV        transcribe one file and exit (testing)\n"
        "  --bench N         with --file: repeat N times and print timings\n"
        "  --verbose         show whisper.cpp logs\n", argv0);
}

}

int main(int argc, char ** argv) {
    bool origins_given = false;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        auto next = [&]() -> const char * {
            if (i + 1 >= argc) { usage(argv[0]); exit(2); }
            return argv[++i];
        };
        if (a == "--model") g_cfg.model = next();
        else if (a == "--host") g_cfg.host = next();
        else if (a == "--port") g_cfg.port = atoi(next());
        else if (a == "--threads") g_cfg.threads = atoi(next());
        else if (a == "--idle") g_cfg.idle_s = atoi(next());
        else if (a == "--lang") g_cfg.lang = next();
        else if (a == "--uid") g_cfg.uid = atoi(next());
        else if (a == "--gid") g_cfg.gid = atoi(next());
        else if (a == "--full-ctx") g_cfg.short_ctx = false;
        else if (a == "--min-ctx") g_cfg.min_ctx = atoi(next());
        else if (a == "--file") g_cfg.file = next();
        else if (a == "--bench") g_cfg.bench = atoi(next());
        else if (a == "--verbose") g_cfg.verbose = true;
        else if (a == "--origin") {
            if (!origins_given) g_cfg.origins.clear();
            origins_given = true;
            g_cfg.origins.push_back(next());
        } else {
            usage(argv[0]);
            return 2;
        }
    }
    if (g_cfg.model.empty() || g_cfg.threads < 1 || g_cfg.idle_s < 1) {
        usage(argv[0]);
        return 2;
    }
    signal(SIGPIPE, SIG_IGN);
    whisper_log_set(whisper_log_cb, nullptr);
    return g_cfg.file.empty() ? run_server() : run_file();
}

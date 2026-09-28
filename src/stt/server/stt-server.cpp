#include "gguf.h"
#include "opus.h"
#include "transcribe.h"
#include "whisper.h"

#include <arpa/inet.h>
#include <dirent.h>
#include <fcntl.h>
#include <grp.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

struct Config {
    std::string models_dir;
    std::string model;
    std::string choice;
    std::string host = "127.0.0.1";
    int port = 8321;
    int threads = 4;
    int idle_s = 15;
    int uid = -1;
    int gid = -1;
    bool short_ctx = true;
    int min_ctx = 320;
    std::vector<std::string> origins = {"http://kaios-voiceassistant.localhost"};
    std::string file;
    int bench = 1;
    bool verbose = false;
};

struct ModelFile {
    std::string file;
    std::string path;
    std::string name;
    bool english = false;
    long mb = 0;
    bool whisper = false;
};

Config g_cfg;
std::vector<ModelFile> g_models;
std::atomic<int> g_want{0};
int g_choice_fd = -1;

std::mutex g_model_mu;
int g_loaded_index = -1;
whisper_context * g_whisper = nullptr;
transcribe_session * g_session = nullptr;
std::atomic<bool> g_loaded{false};
std::atomic<bool> g_warm{false};
std::atomic<long> g_last_use_ms{0};
std::atomic<int> g_sessions{0};
std::atomic<bool> g_unload_now{false};
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

void transcribe_log_cb(transcribe_log_level level, const char * msg, void *) {
    if (g_cfg.verbose || level == TRANSCRIBE_LOG_LEVEL_ERROR) {
        fputs(msg, stderr);
        if (level != TRANSCRIBE_LOG_LEVEL_CONT) fputc('\n', stderr);
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

bool ends_with(const std::string & s, const char * suffix) {
    const size_t n = strlen(suffix);
    return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}

std::string whisper_name(const std::string & file) {
    std::string size = file.substr(0, file.size() - 4);
    if (size.compare(0, 5, "ggml-") == 0) size.erase(0, 5);
    size = size.substr(0, size.find("-q"));
    const bool en = ends_with(size, ".en");
    if (en) size.resize(size.size() - 3);
    if (!size.empty()) size[0] = (char) toupper((unsigned char) size[0]);
    return "Whisper " + size + (en ? " (English)" : "");
}

bool read_model_info(ModelFile & m) {
    struct stat st;
    if (stat(m.path.c_str(), &st) != 0) return false;
    m.mb = (long) ((st.st_size + 500000) / 1000000);
    if (m.whisper) {
        m.name = whisper_name(m.file);
        m.english = m.name.find("(English)") != std::string::npos;
        return true;
    }
    gguf_init_params gp = {true, nullptr};
    gguf_context * g = gguf_init_from_file(m.path.c_str(), gp);
    if (!g) return false;
    const int64_t name = gguf_find_key(g, "general.name");
    m.name = name >= 0 ? gguf_get_val_str(g, name) : m.file;
    const int64_t langs = gguf_find_key(g, "general.languages");
    m.english = langs >= 0 && gguf_get_arr_n(g, langs) == 1 &&
                strcmp(gguf_get_arr_str(g, langs, 0), "en") == 0;
    gguf_free(g);
    return true;
}

void scan_models() {
    std::vector<std::string> files;
    if (DIR * d = opendir(g_cfg.models_dir.c_str())) {
        while (dirent * e = readdir(d)) {
            const std::string f = e->d_name;
            if (ends_with(f, ".gguf") || ends_with(f, ".bin")) files.push_back(f);
        }
        closedir(d);
    }
    std::sort(files.begin(), files.end());
    for (const auto & f : files) {
        ModelFile m;
        m.file = f;
        m.path = g_cfg.models_dir + "/" + f;
        m.whisper = ends_with(f, ".bin");
        if (read_model_info(m)) {
            g_models.push_back(m);
        } else {
            logf("skipping %s: not a model this server can read", m.path.c_str());
        }
    }
}

int find_model(const std::string & file) {
    for (size_t i = 0; i < g_models.size(); i++) {
        if (g_models[i].file == file) return (int) i;
    }
    return -1;
}

void open_choice() {
    if (g_cfg.choice.empty()) return;
    g_choice_fd = open(g_cfg.choice.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0644);
    if (g_choice_fd < 0) {
        logf("can't open %s: %s; a picked model is kept until the service restarts",
             g_cfg.choice.c_str(), strerror(errno));
        return;
    }
    char buf[256];
    const ssize_t n = pread(g_choice_fd, buf, sizeof buf - 1, 0);
    if (n > 0) {
        std::string file(buf, (size_t) n);
        file.erase(file.find_last_not_of(" \r\n\t") + 1);
        if (find_model(file) >= 0) g_want = find_model(file);
    }
}

void save_choice(const std::string & file) {
    if (g_choice_fd < 0) return;
    const std::string line = file + "\n";
    if (pwrite(g_choice_fd, line.data(), line.size(), 0) != (ssize_t) line.size() ||
        ftruncate(g_choice_fd, (off_t) line.size()) != 0) {
        logf("can't save the model choice: %s", strerror(errno));
    }
}

void unload_model(const char * why) {
    if (g_loaded_index < 0) return;
    whisper_free(g_whisper);
    transcribe_session_free(g_session);
    g_whisper = nullptr;
    g_session = nullptr;
    logf("unloaded %s (%s)", g_models[g_loaded_index].file.c_str(), why);
    g_loaded_index = -1;
    g_loaded = false;
    g_warm = false;
}

bool ensure_model() {
    touch();
    const int want = g_want;
    if (g_loaded_index == want) return true;
    unload_model("another model was picked");
    const ModelFile & m = g_models[want];
    auto t0 = std::chrono::steady_clock::now();
    bool ok;
    if (m.whisper) {
        whisper_context_params cp = whisper_context_default_params();
        cp.use_gpu = false;
        cp.flash_attn = true;
        g_whisper = whisper_init_from_file_with_params(m.path.c_str(), cp);
        ok = g_whisper != nullptr;
    } else {
        transcribe_session_params sp;
        transcribe_session_params_init(&sp);
        sp.n_threads = g_cfg.threads;
        ok = transcribe_open(m.path.c_str(), nullptr, &sp, &g_session) == TRANSCRIBE_OK;
    }
    if (!ok) {
        logf("failed to load %s", m.path.c_str());
        return false;
    }
    g_loaded_index = want;
    g_loaded = true;
    logf("loaded %s in %ld ms", m.file.c_str(), ms_since(t0));
    return true;
}

std::string clean_text(const std::string & in) {
    std::string out;
    int depth = 0;
    for (char c : in) {
        if (c == '[' || c == '(') { depth++; continue; }
        if ((c == ']' || c == ')') && depth > 0) { depth--; continue; }
        if (depth == 0) out += c;
    }
    std::string text;
    for (char c : out) {
        if (c == '\n' || c == '\t') c = ' ';
        if (c == ' ' && (text.empty() || text.back() == ' ')) continue;
        text += c;
    }
    while (!text.empty() && text.back() == ' ') text.pop_back();

    bool sentence_start = true;
    for (size_t i = 0; i < text.size(); i++) {
        const unsigned char c = (unsigned char) text[i];
        const bool word_start = i == 0 || text[i - 1] == ' ';
        if (sentence_start && isalpha(c)) {
            text[i] = (char) toupper(c);
        } else if (c == 'i' && word_start) {
            const char next = i + 1 < text.size() ? text[i + 1] : ' ';
            if (next == ' ' || next == '\'' || next == ',' || next == '.' || next == '?' || next == '!') {
                text[i] = 'I';
            }
        }
        if (isalnum(c)) {
            sentence_start = false;
        } else if ((c == '.' || c == '?' || c == '!') && (i + 1 == text.size() || text[i + 1] == ' ')) {
            sentence_start = true;
        }
    }
    return text;
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

bool run_whisper(const std::vector<float> & pcm, const char * lang, AbortCheck & check,
                 std::string & raw, std::string & err, float * confidence) {
    const float seconds = (float) pcm.size() / kSampleRate;
    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.n_threads = g_cfg.threads;
    p.language = whisper_is_multilingual(g_whisper) ? (lang ? lang : "auto") : "en";
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
    p.abort_callback = should_abort;
    p.abort_callback_user_data = &check;

    if (whisper_full(g_whisper, p, pcm.data(), (int) pcm.size()) != 0) {
        err = check.why ? check.why : "whisper_full failed";
        return false;
    }
    const int n = whisper_full_n_segments(g_whisper);
    for (int i = 0; i < n; i++) {
        raw += whisper_full_get_segment_text(g_whisper, i);
    }
    if (confidence) {
        const whisper_token eot = whisper_token_eot(g_whisper);
        double sum = 0;
        int count = 0;
        for (int i = 0; i < n; i++) {
            const int nt = whisper_full_n_tokens(g_whisper, i);
            for (int j = 0; j < nt; j++) {
                const whisper_token_data td = whisper_full_get_token_data(g_whisper, i, j);
                if (td.id < eot) {
                    sum += td.p;
                    count++;
                }
            }
        }
        *confidence = count ? (float) (sum / count) : 0.0f;
    }
    return true;
}

bool run_transcribe(const std::vector<float> & pcm, const char * lang, AbortCheck & check,
                    std::string & raw, std::string & err, float * confidence) {
    transcribe_set_abort_callback(g_session, should_abort, &check);
    transcribe_run_params rp;
    transcribe_run_params_init(&rp);
    rp.timestamps = TRANSCRIBE_TIMESTAMPS_NONE;
    rp.language = g_models[g_loaded_index].english ? "en" : lang;
    const transcribe_status st = transcribe_run(g_session, pcm.data(), (int) pcm.size(), &rp);
    if (st != TRANSCRIBE_OK && st != TRANSCRIBE_ERR_OUTPUT_TRUNCATED &&
        st != TRANSCRIBE_ERR_OUTPUT_REPETITION) {
        err = check.why ? check.why : transcribe_status_string(st);
        return false;
    }
    raw = transcribe_full_text(g_session);
    if (confidence) {
        *confidence = raw.empty() ? 0.0f : 1.0f;
    }
    return true;
}

bool transcribe(const std::vector<float> & pcm, const char * lang, std::string & text,
                std::string & err, int client_fd = -1, unsigned job = 0, float * confidence = nullptr) {
    if (!ensure_model()) {
        err = "model failed to load";
        return false;
    }
    AbortCheck check;
    check.deadline = std::chrono::steady_clock::now() +
                     std::chrono::milliseconds((long) (5000 + pcm.size() * 1000 / kSampleRate));
    check.client_fd = client_fd;
    check.job = job;
    std::string raw;
    const bool ok = g_whisper ? run_whisper(pcm, lang, check, raw, err, confidence)
                              : run_transcribe(pcm, lang, check, raw, err, confidence);
    touch();
    if (!ok) return false;
    text = clean_text(raw);
    g_warm = true;
    return true;
}

bool warmup() {
    if (g_warm && g_loaded_index == g_want) {
        return true;
    }
    auto t0 = std::chrono::steady_clock::now();
    std::vector<float> silence(kSampleRate, 0.0f);
    std::string text, err;
    if (!transcribe(silence, nullptr, text, err)) {
        logf("warmup failed: %s", err.c_str());
        return false;
    }
    logf("ready in %ld ms", ms_since(t0));
    return true;
}

void warm_in_background() {
    std::thread([]() {
        std::lock_guard<std::mutex> lock(g_model_mu);
        if (g_sessions > 0) warmup();
    }).detach();
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

bool decode_ogg_opus(const std::string & body, std::vector<float> & pcm, std::string & err) {
    const uint8_t * d = (const uint8_t *) body.data();
    const size_t len = body.size();
    constexpr int kMaxFrame = kSampleRate * 120 / 1000;
    std::vector<float> frame(kMaxFrame);
    std::string packet;
    OpusDecoder * dec = nullptr;
    int packets = 0;
    int pre_skip = 0;
    uint32_t serial = 0;
    size_t pos = 0;

    auto on_packet = [&]() -> bool {
        const uint8_t * p = (const uint8_t *) packet.data();
        const size_t n = packet.size();
        if (packets++ == 0) {
            if (n < 19 || memcmp(p, "OpusHead", 8) != 0) {
                err = "not an Ogg/Opus stream";
                return false;
            }
            if (p[18] != 0) {
                err = "multichannel Opus is not supported";
                return false;
            }
            pre_skip = p[10] | (p[11] << 8);
            int e = 0;
            dec = opus_decoder_create(kSampleRate, 1, &e);
            if (!dec || e != OPUS_OK) {
                err = "opus decoder init failed";
                return false;
            }
            return true;
        }
        if (n >= 8 && memcmp(p, "OpusTags", 8) == 0) {
            return true;
        }
        const int got = opus_decode_float(dec, p, (opus_int32) n, frame.data(), kMaxFrame, 0);
        if (got < 0) {
            err = std::string("opus: ") + opus_strerror(got);
            return false;
        }
        pcm.insert(pcm.end(), frame.begin(), frame.begin() + got);
        if (pcm.size() > kMaxSeconds * kSampleRate) {
            err = "audio longer than 60 s";
            return false;
        }
        return true;
    };

    bool ok = true;
    while (ok && pos + 27 <= len) {
        if (memcmp(d + pos, "OggS", 4) != 0) {
            err = "bad Ogg page";
            ok = false;
            break;
        }
        uint32_t sn;
        memcpy(&sn, d + pos + 14, 4);
        const int nseg = d[pos + 26];
        const uint8_t * lacing = d + pos + 27;
        size_t off = pos + 27 + nseg;
        size_t total = 0;
        if (off <= len) {
            for (int i = 0; i < nseg; i++) total += lacing[i];
        }
        if (off > len || off + total > len) {
            err = "truncated Ogg page";
            ok = false;
            break;
        }
        if (pos == 0) serial = sn;
        if (sn == serial) {
            for (int i = 0; i < nseg && ok; i++) {
                packet.append((const char *) d + off, lacing[i]);
                off += lacing[i];
                if (lacing[i] < 255) {
                    ok = on_packet();
                    packet.clear();
                }
            }
        }
        pos = pos + 27 + nseg + total;
    }
    if (dec) opus_decoder_destroy(dec);
    if (!ok) return false;
    if (packets == 0) {
        err = "empty Ogg stream";
        return false;
    }
    const size_t skip = std::min(pcm.size(), (size_t) pre_skip * kSampleRate / 48000);
    pcm.erase(pcm.begin(), pcm.begin() + skip);
    if (pcm.size() < (size_t) kSampleRate / 4) {
        err = "audio too short";
        return false;
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

std::string cors_headers(const std::string & origin, const std::string & allow_headers = "Content-Type") {
    if (origin.empty()) return "";
    return "Access-Control-Allow-Origin: " + origin + "\r\n"
           "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
           "Access-Control-Allow-Headers: " + allow_headers + "\r\n"
           "Access-Control-Max-Age: 86400\r\n"
           "Vary: Origin\r\n";
}

void respond(int fd, int status, const std::string & origin, const std::string & body,
             const std::string & allow_headers = "Content-Type") {
    const char * reason = status == 200 ? "OK" : status == 204 ? "No Content"
                        : status == 400 ? "Bad Request" : status == 403 ? "Forbidden"
                        : status == 404 ? "Not Found" : status == 413 ? "Payload Too Large"
                        : "Internal Server Error";
    std::string h = "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\n";
    h += cors_headers(origin, allow_headers);
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

std::string models_json() {
    std::string o = "{\"current\":\"" + json_escape(g_models[g_want].file) + "\",\"models\":[";
    for (size_t i = 0; i < g_models.size(); i++) {
        const ModelFile & m = g_models[i];
        o += std::string(i ? "," : "") + "{\"file\":\"" + json_escape(m.file) + "\",\"name\":\"" +
             json_escape(m.name) + "\",\"english\":" + (m.english ? "true" : "false") +
             ",\"mb\":" + std::to_string(m.mb) + "}";
    }
    return o + "]}";
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
    if (!transcribe(pcm, nullptr, text, err, fd, job)) {
        logf("abandoned %ld ms of audio after %ld ms: %s", audio_ms, ms_since(t0), err.c_str());
        respond(fd, 500, origin, "{\"error\":\"" + json_escape(err) + "\"}");
        return;
    }
    const long ms = ms_since(t0);
    logf("transcribed %ld ms of audio in %ld ms (%zu chars)", audio_ms, ms, text.size());
    respond(fd, 200, origin, "{\"text\":\"" + json_escape(text) + "\",\"audio_ms\":" +
            std::to_string(audio_ms) + ",\"ms\":" + std::to_string(ms) + "}");
}

constexpr float kMinConfidence = 0.15f;

void run_speaktome(int fd, unsigned job, const std::string & origin, const std::string & lang,
                   const std::vector<float> & pcm) {
    const long audio_ms = (long) (pcm.size() * 1000 / kSampleRate);
    std::lock_guard<std::mutex> lock(g_model_mu);
    std::string err, text;
    float confidence = 0.0f;
    auto t0 = std::chrono::steady_clock::now();
    if (job != g_latest_job) {
        err = "superseded by a newer request";
    } else if (transcribe(pcm, lang.empty() ? nullptr : lang.c_str(), text, err, fd, job, &confidence) &&
               (text.empty() || confidence < kMinConfidence)) {
        err = "no speech";
    }
    if (!err.empty()) {
        logf("speaktome: %ld ms of audio: %s", audio_ms, err.c_str());
        respond(fd, 200, origin, "{\"status\":\"error\",\"message\":\"" + json_escape(err) + "\"}");
        return;
    }
    logf("speaktome: transcribed %ld ms of audio in %ld ms (%zu chars)", audio_ms, ms_since(t0), text.size());
    char conf[32];
    snprintf(conf, sizeof conf, "%.3f", confidence);
    respond(fd, 200, origin, "{\"status\":\"ok\",\"data\":[{\"text\":\"" + json_escape(text) +
            "\",\"confidence\":" + conf + "}]}");
}

enum class Handled {
    Close,
    Worker,
    Session,
};

Handled handle_client(int fd) {
    timeval tv{5, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);

    std::string buf;
    size_t head_end;
    char tmp[16384];
    while ((head_end = buf.find("\r\n\r\n")) == std::string::npos) {
        if (buf.size() > kMaxHeader) return Handled::Close;
        ssize_t r = recv(fd, tmp, sizeof tmp, 0);
        if (r <= 0) return Handled::Close;
        buf.append(tmp, (size_t) r);
    }
    const std::string head = buf.substr(0, head_end);
    std::string body = buf.substr(head_end + 4);

    const size_t sp1 = head.find(' ');
    const size_t sp2 = head.find(' ', sp1 + 1);
    if (sp1 == std::string::npos || sp2 == std::string::npos) return Handled::Close;
    const std::string method = head.substr(0, sp1);
    std::string path = head.substr(sp1 + 1, sp2 - sp1 - 1);
    path = path.substr(0, path.find('?'));

    const bool speaktome = path == "/speaktome" || path == "/speaktome/";
    const std::string origin = header_value(head, "Origin");
    if (!speaktome && !origin_allowed(origin)) {
        logf("rejected origin %s", origin.c_str());
        respond(fd, 403, "", "{\"error\":\"origin not allowed\"}");
        return Handled::Close;
    }

    if (method == "OPTIONS") {
        const std::string asked = header_value(head, "Access-Control-Request-Headers");
        respond(fd, 204, origin, "", speaktome && !asked.empty() ? asked : "Content-Type");
        return Handled::Close;
    }
    if (method == "GET" && path == "/health") {
        respond(fd, 200, origin, std::string("{\"ok\":true,\"loaded\":") + (g_loaded ? "true" : "false") +
                ",\"model\":\"" + json_escape(g_models[g_want].file) + "\",\"name\":\"" +
                json_escape(g_models[g_want].name) + "\",\"threads\":" + std::to_string(g_cfg.threads) +
                ",\"sessions\":" + std::to_string(g_sessions) + "}");
        return Handled::Close;
    }
    if (method == "GET" && path == "/session") {
        send_all(fd, "HTTP/1.1 200 OK\r\n" + cors_headers(origin) +
                     "Content-Type: text/event-stream\r\nCache-Control: no-store\r\n\r\n: open\n\n");
        return Handled::Session;
    }
    if (method == "GET" && path == "/models") {
        respond(fd, 200, origin, models_json());
        return Handled::Close;
    }

    const bool post_audio = method == "POST" && (path == "/transcribe" || speaktome);
    if (!post_audio && !(method == "POST" && path == "/model")) {
        respond(fd, 404, origin, "{\"error\":\"not found\"}");
        return Handled::Close;
    }
    const std::string cl = header_value(head, "Content-Length");
    const size_t want = cl.empty() ? 0 : strtoul(cl.c_str(), nullptr, 10);
    if (want == 0) {
        respond(fd, 400, origin, "{\"error\":\"Content-Length required\"}");
        return Handled::Close;
    }
    if (want > kMaxBody) {
        respond(fd, 413, origin, "{\"error\":\"audio longer than 60 s\"}");
        return Handled::Close;
    }
    while (body.size() < want) {
        ssize_t r = recv(fd, tmp, sizeof tmp, 0);
        if (r <= 0) return Handled::Close;
        body.append(tmp, (size_t) r);
    }
    body.resize(want);

    if (!post_audio) {
        body.erase(body.find_last_not_of(" \r\n\t") + 1);
        const int i = find_model(body);
        if (i < 0) {
            respond(fd, 400, origin, "{\"error\":\"no model called " + json_escape(body) + "\"}");
            return Handled::Close;
        }
        if (i != g_want) {
            g_want = i;
            save_choice(body);
            logf("model picked: %s", body.c_str());
            if (g_sessions > 0) {
                warm_in_background();
            } else if (g_loaded) {
                g_unload_now = true;
            }
        }
        respond(fd, 200, origin, models_json());
        return Handled::Close;
    }

    std::vector<float> pcm;
    std::string err;
    const bool ogg = body.size() >= 4 && memcmp(body.data(), "OggS", 4) == 0;
    if (!(ogg ? decode_ogg_opus(body, pcm, err) : decode_audio(body, pcm, err))) {
        respond(fd, speaktome ? 200 : 400, origin, speaktome ?
                "{\"status\":\"error\",\"message\":\"" + json_escape(err) + "\"}" :
                "{\"error\":\"" + json_escape(err) + "\"}");
        return Handled::Close;
    }
    std::string lang = speaktome ? header_value(head, "Accept-Language-STT") : "";
    lang = lang.substr(0, lang.find_first_of("-_"));
    for (char & c : lang) c = (char) tolower((unsigned char) c);

    const unsigned job = ++g_latest_job;
    std::thread([fd, job, origin, speaktome, lang, pcm = std::move(pcm)]() {
        if (speaktome) {
            run_speaktome(fd, job, origin, lang, pcm);
        } else {
            run_job(fd, job, origin, pcm);
        }
        close(fd);
    }).detach();
    return Handled::Worker;
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
    const bool ogg = body.size() >= 4 && memcmp(body.data(), "OggS", 4) == 0;
    if (!(ogg ? decode_ogg_opus(body, pcm, err) : decode_audio(body, pcm, err))) {
        logf("%s", err.c_str());
        return 1;
    }
    if (!ensure_model()) return 1;
    for (int i = 0; i < g_cfg.bench; i++) {
        auto t0 = std::chrono::steady_clock::now();
        if (!transcribe(pcm, nullptr, text, err)) {
            logf("%s", err.c_str());
            return 1;
        }
        logf("run %d: %zu ms audio -> %ld ms, threads=%d", i + 1,
             pcm.size() * 1000 / kSampleRate, ms_since(t0), g_cfg.threads);
    }
    printf("%s\n", text.c_str());
    unload_model("done");
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
    if (bind(s, (sockaddr *) &addr, sizeof addr) != 0 || listen(s, 8) != 0) {
        logf("cannot listen on %s:%d: %s", g_cfg.host.c_str(), g_cfg.port, strerror(errno));
        return 1;
    }
    open_choice();
    if (!drop_privileges()) return 1;
    for (const auto & m : g_models) {
        if (access(m.path.c_str(), R_OK) != 0) {
            logf("WARNING: model %s not readable: %s", m.path.c_str(), strerror(errno));
        }
    }
    logf("listening on %s:%d (model %s of %zu, %d threads, idle unload %ds)", g_cfg.host.c_str(),
         g_cfg.port, g_models[g_want].file.c_str(), g_models.size(), g_cfg.threads, g_cfg.idle_s);

    std::vector<int> sessions;
    for (;;) {
        std::vector<pollfd> pfds{{s, POLLIN, 0}};
        for (int fd : sessions) pfds.push_back({fd, POLLIN, 0});
        int timeout = -1;
        if (sessions.empty() && (g_loaded || g_unload_now)) {
            const long left = g_unload_now ? 0 : (long) g_cfg.idle_s * 1000 - (now_ms() - g_last_use_ms);
            timeout = left > 0 ? (int) left + 1 : 100;
        }
        const int pr = poll(pfds.data(), pfds.size(), timeout);
        if (pr < 0 && errno != EINTR) {
            logf("poll: %s", strerror(errno));
            return 1;
        }
        for (size_t i = 1; pr > 0 && i < pfds.size(); i++) {
            if (!pfds[i].revents) continue;
            char c[256];
            const ssize_t r = recv(pfds[i].fd, c, sizeof c, MSG_DONTWAIT);
            if (r > 0 || (r < 0 && (errno == EAGAIN || errno == EINTR))) continue;
            close(pfds[i].fd);
            sessions.erase(std::find(sessions.begin(), sessions.end(), pfds[i].fd));
            g_sessions = (int) sessions.size();
            if (sessions.empty()) g_unload_now = true;
        }
        if (pr > 0 && (pfds[0].revents & POLLIN)) {
            int c = accept4(s, nullptr, nullptr, SOCK_CLOEXEC);
            if (c >= 0) {
                setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
                switch (handle_client(c)) {
                    case Handled::Close:
                        close(c);
                        break;
                    case Handled::Worker:
                        break;
                    case Handled::Session:
                        sessions.push_back(c);
                        g_sessions = (int) sessions.size();
                        g_unload_now = false;
                        warm_in_background();
                        break;
                }
            }
        }
        if (sessions.empty() &&
            (g_unload_now || (g_loaded && now_ms() - g_last_use_ms >= (long) g_cfg.idle_s * 1000))) {
            std::unique_lock<std::mutex> lock(g_model_mu, std::try_to_lock);
            if (lock.owns_lock()) {
                unload_model(g_unload_now ? "no KaiVA window open" : "idle");
                g_unload_now = false;
            }
        }
    }
}

void usage(const char * argv0) {
    fprintf(stderr,
        "usage: %s --model FILE [options]\n"
        "  --model FILE      the model to use until someone picks another: a file in\n"
        "                    --models, or with --file any model file\n"
        "  --models DIR      the models to offer: every .gguf and .bin in DIR\n"
        "                    (default: the directory of --model)\n"
        "  --choice FILE     keep the picked model's name here\n"
        "  --host ADDR       listen address (default 127.0.0.1)\n"
        "  --port N          listen port (default 8321)\n"
        "  --threads N       inference threads (default 4)\n"
        "  --idle SECONDS    without a session, free the model after this long unused\n"
        "                    (default 15)\n"
        "  --origin URL      allowed browser Origin, repeatable, '*' = any\n"
        "                    (default http://kaios-voiceassistant.localhost)\n"
        "  --uid N [--gid N] drop root to this uid/gid after binding\n"
        "  --full-ctx        Whisper: always encode the full 30 s window (slower)\n"
        "  --min-ctx N       Whisper: smallest encoder window in 20 ms frames (default 320)\n"
        "  --file FILE       transcribe one WAV / raw PCM / Ogg Opus file and exit\n"
        "  --bench N         with --file: repeat N times and print timings\n"
        "  --verbose         show whisper.cpp / transcribe.cpp logs\n", argv0);
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
        else if (a == "--models") g_cfg.models_dir = next();
        else if (a == "--choice") g_cfg.choice = next();
        else if (a == "--host") g_cfg.host = next();
        else if (a == "--port") g_cfg.port = atoi(next());
        else if (a == "--threads") g_cfg.threads = atoi(next());
        else if (a == "--idle") g_cfg.idle_s = atoi(next());
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
    transcribe_log_set(transcribe_log_cb, nullptr);

    const size_t slash = g_cfg.model.rfind('/');
    if (g_cfg.models_dir.empty()) {
        g_cfg.models_dir = slash == std::string::npos ? "." : g_cfg.model.substr(0, slash);
    }
    const std::string default_file = slash == std::string::npos ? g_cfg.model : g_cfg.model.substr(slash + 1);
    scan_models();
    if (g_models.empty()) {
        logf("no models in %s", g_cfg.models_dir.c_str());
        return 1;
    }
    const int def = find_model(default_file);
    if (def < 0) {
        logf("%s isn't in %s; using %s", default_file.c_str(), g_cfg.models_dir.c_str(),
             g_models[0].file.c_str());
    }
    g_want = def < 0 ? 0 : def;
    return g_cfg.file.empty() ? run_server() : run_file();
}

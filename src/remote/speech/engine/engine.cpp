#include "engine.h"

#include "gguf.h"
#include "opus.h"
#include "transcribe.h"
#include "whisper.h"

#include <sys/stat.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

struct stt_model {
    whisper_context * whisper = nullptr;
    transcribe_session * session = nullptr;
    bool english = false;
    int threads = 4;
};

namespace {

constexpr int kSampleRate = WHISPER_SAMPLE_RATE;
constexpr size_t kMaxSeconds = 60;
constexpr int kMinCtx = 320;

void (*g_log)(const char *) = nullptr;

void log_error(const char * text) {
    if (g_log) {
        std::string line(text);
        while (!line.empty() && line.back() == '\n') line.pop_back();
        if (!line.empty()) g_log(line.c_str());
    }
}

void whisper_log_cb(ggml_log_level level, const char * text, void *) {
    if (level == GGML_LOG_LEVEL_ERROR) log_error(text);
}

void transcribe_log_cb(transcribe_log_level level, const char * text, void *) {
    if (level == TRANSCRIBE_LOG_LEVEL_ERROR) log_error(text);
}

bool ends_with(const std::string & s, const char * suffix) {
    const size_t n = strlen(suffix);
    return s.size() >= n && s.compare(s.size() - n, n, suffix) == 0;
}

std::string whisper_name(const std::string & path) {
    std::string size = path.substr(path.rfind('/') + 1);
    size.resize(size.size() - 4);
    if (size.compare(0, 5, "ggml-") == 0) size.erase(0, 5);
    size = size.substr(0, size.find("-q"));
    const bool en = ends_with(size, ".en");
    if (en) size.resize(size.size() - 3);
    if (!size.empty()) size[0] = (char) toupper((unsigned char) size[0]);
    return "Whisper " + size + (en ? " (English)" : "");
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
    stt_abort abort;
    void * data;
    const char * why = nullptr;
};

bool should_abort(void * data) {
    auto * a = (AbortCheck *) data;
    if (std::chrono::steady_clock::now() > a->deadline) {
        a->why = "took too long";
        return true;
    }
    if (a->abort && a->abort(a->data)) {
        a->why = "stopped";
        return true;
    }
    return false;
}

bool run_whisper(stt_model * m, const std::vector<float> & pcm, const char * lang, AbortCheck & check,
                 std::string & raw, std::string & err, float * confidence) {
    const float seconds = (float) pcm.size() / kSampleRate;
    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.n_threads = m->threads;
    p.language = whisper_is_multilingual(m->whisper) ? (lang ? lang : "auto") : "en";
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
    int frames = (int) (seconds * 50) + 128;
    if (frames < kMinCtx) frames = kMinCtx;
    p.audio_ctx = frames < 1500 ? frames : 0;
    p.abort_callback = should_abort;
    p.abort_callback_user_data = &check;

    if (whisper_full(m->whisper, p, pcm.data(), (int) pcm.size()) != 0) {
        err = check.why ? check.why : "whisper_full failed";
        return false;
    }
    const int n = whisper_full_n_segments(m->whisper);
    for (int i = 0; i < n; i++) {
        raw += whisper_full_get_segment_text(m->whisper, i);
    }
    const whisper_token eot = whisper_token_eot(m->whisper);
    double sum = 0;
    int count = 0;
    for (int i = 0; i < n; i++) {
        const int nt = whisper_full_n_tokens(m->whisper, i);
        for (int j = 0; j < nt; j++) {
            const whisper_token_data td = whisper_full_get_token_data(m->whisper, i, j);
            if (td.id < eot) {
                sum += td.p;
                count++;
            }
        }
    }
    *confidence = count ? (float) (sum / count) : 0.0f;
    return true;
}

bool run_transcribe(stt_model * m, const std::vector<float> & pcm, const char * lang, AbortCheck & check,
                    std::string & raw, std::string & err, float * confidence) {
    transcribe_set_abort_callback(m->session, should_abort, &check);
    transcribe_run_params rp;
    transcribe_run_params_init(&rp);
    rp.timestamps = TRANSCRIBE_TIMESTAMPS_NONE;
    rp.language = m->english ? "en" : lang;
    const transcribe_status st = transcribe_run(m->session, pcm.data(), (int) pcm.size(), &rp);
    if (st != TRANSCRIBE_OK && st != TRANSCRIBE_ERR_OUTPUT_TRUNCATED && st != TRANSCRIBE_ERR_OUTPUT_REPETITION) {
        err = check.why ? check.why : transcribe_status_string(st);
        return false;
    }
    raw = transcribe_full_text(m->session);
    *confidence = raw.empty() ? 0.0f : 1.0f;
    return true;
}

bool decode_pcm(const uint8_t * d, size_t len, std::vector<float> & pcm, std::string & err) {
    size_t off = 0;
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
    if (n > kMaxSeconds * kSampleRate) {
        err = "audio longer than 60 s";
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

bool decode_ogg_opus(const uint8_t * d, size_t len, std::vector<float> & pcm, std::string & err) {
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
    return true;
}

void set_err(char * err, size_t size, const std::string & why) {
    snprintf(err, size, "%s", why.c_str());
}

}  // namespace

extern "C" void stt_set_log(void (*log)(const char *)) {
    g_log = log;
    whisper_log_set(whisper_log_cb, nullptr);
    transcribe_log_set(transcribe_log_cb, nullptr);
}

extern "C" int stt_model_info(const char * path, char * name, size_t name_size, int * english) {
    struct stat st;
    if (stat(path, &st) != 0) return 0;
    std::string shown;
    if (ends_with(path, ".bin")) {
        shown = whisper_name(path);
        *english = shown.find("(English)") != std::string::npos;
    } else {
        gguf_init_params gp = {true, nullptr};
        gguf_context * g = gguf_init_from_file(path, gp);
        if (!g) return 0;
        const int64_t key = gguf_find_key(g, "general.name");
        const char * file = strrchr(path, '/');
        shown = key >= 0 ? gguf_get_val_str(g, key) : (file ? file + 1 : path);
        const int64_t langs = gguf_find_key(g, "general.languages");
        *english = langs >= 0 && gguf_get_arr_n(g, langs) == 1 && strcmp(gguf_get_arr_str(g, langs, 0), "en") == 0;
        gguf_free(g);
    }
    snprintf(name, name_size, "%s", shown.c_str());
    return 1;
}

extern "C" stt_model * stt_load(const char * path, int threads) {
    auto * m = new stt_model;
    m->threads = threads;
    bool ok;
    if (ends_with(path, ".bin")) {
        whisper_context_params cp = whisper_context_default_params();
        cp.use_gpu = false;
        cp.flash_attn = true;
        m->whisper = whisper_init_from_file_with_params(path, cp);
        ok = m->whisper != nullptr;
    } else {
        char name[256];
        int english = 0;
        ok = stt_model_info(path, name, sizeof name, &english);
        m->english = english;
        transcribe_session_params sp;
        transcribe_session_params_init(&sp);
        sp.n_threads = threads;
        ok = ok && transcribe_open(path, nullptr, &sp, &m->session) == TRANSCRIBE_OK;
    }
    if (!ok) {
        stt_free(m);
        return nullptr;
    }
    return m;
}

extern "C" void stt_free(stt_model * m) {
    if (!m) return;
    whisper_free(m->whisper);
    transcribe_session_free(m->session);
    delete m;
}

extern "C" int stt_transcribe(stt_model * m, const uint8_t * audio, size_t len, const char * lang, stt_abort abort,
                              void * data, char ** text, float * confidence, long * audio_ms, char * err,
                              size_t err_size) {
    std::vector<float> pcm;
    std::string why;
    const bool ogg = len >= 4 && memcmp(audio, "OggS", 4) == 0;
    if (!(ogg ? decode_ogg_opus(audio, len, pcm, why) : decode_pcm(audio, len, pcm, why))) {
        set_err(err, err_size, why);
        return 0;
    }
    *audio_ms = (long) (pcm.size() * 1000 / kSampleRate);
    if (pcm.size() < (size_t) kSampleRate / 4) {
        set_err(err, err_size, "audio too short");
        return 0;
    }
    AbortCheck check;
    check.deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(5000 + *audio_ms);
    check.abort = abort;
    check.data = data;
    std::string raw;
    const bool ok = m->whisper ? run_whisper(m, pcm, lang, check, raw, why, confidence)
                               : run_transcribe(m, pcm, lang, check, raw, why, confidence);
    if (!ok) {
        set_err(err, err_size, why);
        return 0;
    }
    *text = strdup(clean_text(raw).c_str());
    return *text != nullptr;
}

extern "C" void stt_text_free(char * text) {
    free(text);
}

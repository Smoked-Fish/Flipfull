#include <binder/ProcessState.h>
#include <media/AudioRecord.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>
#include <media/NdkMediaMuxer.h>

#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>

using namespace android;

namespace {

constexpr uint32_t kRate = 16000;
constexpr int kBitrate = 32000;
constexpr size_t kChunk = kRate / 10;
constexpr uint64_t kMaxSamples = 4ull * 3600 * kRate;
constexpr int kOut = 3;
constexpr int kFlushMs = 5000;

void say(const char * fmt, ...) __attribute__((format(printf, 1, 2)));
void say(const char * fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    putchar('\n');
    fflush(stdout);
}

bool told_to_stop() {
    pollfd p = {0, POLLIN, 0};
    if (poll(&p, 1, 0) <= 0) {
        return false;
    }
    char buf[64];
    ssize_t n = read(0, buf, sizeof buf);
    return n <= 0 || memmem(buf, (size_t) n, "stop", 4) != nullptr;
}

bool write_all(const void * data, size_t n) {
    const uint8_t * p = static_cast<const uint8_t *>(data);
    while (n) {
        ssize_t w = write(kOut, p, n);
        if (w < 0 && errno == EINTR) {
            continue;
        }
        if (w <= 0) {
            return false;
        }
        p += w;
        n -= (size_t) w;
    }
    return true;
}

struct Aac {
    AMediaCodec * codec = nullptr;
    AMediaMuxer * mux = nullptr;
    int track = -1;
    bool eos = false;
    uint64_t samples = 0;

    bool open() {
        codec = AMediaCodec_createEncoderByType("audio/mp4a-latm");
        if (!codec) {
            return false;
        }
        AMediaFormat * f = AMediaFormat_new();
        AMediaFormat_setString(f, AMEDIAFORMAT_KEY_MIME, "audio/mp4a-latm");
        AMediaFormat_setInt32(f, AMEDIAFORMAT_KEY_SAMPLE_RATE, kRate);
        AMediaFormat_setInt32(f, AMEDIAFORMAT_KEY_CHANNEL_COUNT, 1);
        AMediaFormat_setInt32(f, AMEDIAFORMAT_KEY_BIT_RATE, kBitrate);
        AMediaFormat_setInt32(f, AMEDIAFORMAT_KEY_AAC_PROFILE, 2);
        AMediaFormat_setInt32(f, AMEDIAFORMAT_KEY_MAX_INPUT_SIZE, 8192);
        media_status_t st = AMediaCodec_configure(codec, f, nullptr, nullptr, AMEDIACODEC_CONFIGURE_FLAG_ENCODE);
        AMediaFormat_delete(f);
        if (st != AMEDIA_OK || AMediaCodec_start(codec) != AMEDIA_OK) {
            fprintf(stderr, "callcap: the AAC encoder would not start (%d)\n", st);
            AMediaCodec_delete(codec);
            codec = nullptr;
            return false;
        }
        mux = AMediaMuxer_new(kOut, AMEDIAMUXER_OUTPUT_FORMAT_MPEG_4);
        if (!mux) {
            fprintf(stderr, "callcap: the muxer would not open\n");
            AMediaCodec_stop(codec);
            AMediaCodec_delete(codec);
            codec = nullptr;
            return false;
        }
        return true;
    }

    void drain() {
        for (;;) {
            AMediaCodecBufferInfo info;
            ssize_t o = AMediaCodec_dequeueOutputBuffer(codec, &info, 0);
            if (o == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
                AMediaFormat * f = AMediaCodec_getOutputFormat(codec);
                track = (int) AMediaMuxer_addTrack(mux, f);
                AMediaFormat_delete(f);
                if (track < 0 || AMediaMuxer_start(mux) != AMEDIA_OK) {
                    fprintf(stderr, "callcap: the muxer would not start\n");
                    track = -1;
                }
            } else if (o >= 0) {
                size_t cap;
                uint8_t * b = AMediaCodec_getOutputBuffer(codec, (size_t) o, &cap);
                if (b && info.size > 0 && track >= 0 && !(info.flags & AMEDIACODEC_BUFFER_FLAG_CODEC_CONFIG)) {
                    AMediaMuxer_writeSampleData(mux, (size_t) track, b, &info);
                }
                AMediaCodec_releaseOutputBuffer(codec, (size_t) o, false);
                if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) {
                    eos = true;
                    return;
                }
            } else if (o != AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED) {
                return;
            }
        }
    }

    bool write(const int16_t * pcm, size_t n) {
        const uint8_t * p = reinterpret_cast<const uint8_t *>(pcm);
        size_t bytes = n * 2;
        while (bytes) {
            ssize_t i = AMediaCodec_dequeueInputBuffer(codec, 100000);
            if (i < 0) {
                fprintf(stderr, "callcap: the AAC encoder is not taking input\n");
                return false;
            }
            size_t cap;
            uint8_t * b = AMediaCodec_getInputBuffer(codec, (size_t) i, &cap);
            size_t k = (bytes < cap ? bytes : cap) & ~(size_t) 1;
            if (!b || !k) {
                return false;
            }
            memcpy(b, p, k);
            if (AMediaCodec_queueInputBuffer(codec, (size_t) i, 0, k, samples * 1000000 / kRate, 0) != AMEDIA_OK) {
                return false;
            }
            samples += k / 2;
            p += k;
            bytes -= k;
            drain();
        }
        return true;
    }

    bool close() {
        ssize_t i = AMediaCodec_dequeueInputBuffer(codec, 200000);
        if (i >= 0) {
            AMediaCodec_queueInputBuffer(codec, (size_t) i, 0, 0, samples * 1000000 / kRate,
                                         AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);
        }
        for (int ms = 0; ms < kFlushMs && !eos; ms += 10) {
            drain();
            if (!eos) {
                usleep(10000);
            }
        }
        bool ok = eos && track >= 0 && AMediaMuxer_stop(mux) == AMEDIA_OK;
        AMediaMuxer_delete(mux);
        AMediaCodec_stop(codec);
        AMediaCodec_delete(codec);
        return ok;
    }
};

struct Wav {
    uint64_t samples = 0;

    static void header(uint8_t * h, uint32_t data) {
        auto put32 = [&](int at, uint32_t v) {
            for (int i = 0; i < 4; i++) h[at + i] = (uint8_t) (v >> (8 * i));
        };
        auto put16 = [&](int at, uint16_t v) {
            h[at] = (uint8_t) v;
            h[at + 1] = (uint8_t) (v >> 8);
        };
        memcpy(h, "RIFF", 4);
        put32(4, 36 + data);
        memcpy(h + 8, "WAVEfmt ", 8);
        put32(16, 16);
        put16(20, 1);
        put16(22, 1);
        put32(24, kRate);
        put32(28, kRate * 2);
        put16(32, 2);
        put16(34, 16);
        memcpy(h + 36, "data", 4);
        put32(40, data);
    }

    bool open() {
        uint8_t h[44];
        header(h, 0);
        return write_all(h, sizeof h);
    }

    bool write(const int16_t * pcm, size_t n) {
        samples += n;
        return write_all(pcm, n * 2);
    }

    bool close() {
        uint8_t h[44];
        header(h, (uint32_t) (samples * 2));
        return pwrite(kOut, h, sizeof h, 0) == (ssize_t) sizeof h;
    }
};

sp<AudioRecord> open_call(const content::AttributionSourceState & attr) {
    sp<AudioRecord> rec = new AudioRecord(attr);
    audio_attributes_t attrs = AUDIO_ATTRIBUTES_INITIALIZER;
    attrs.source = AUDIO_SOURCE_VOICE_CALL;
    status_t st = rec->set(AUDIO_SOURCE_VOICE_CALL, kRate, AUDIO_FORMAT_PCM_16_BIT, AUDIO_CHANNEL_IN_MONO, kRate,
                           nullptr, 0, false, AUDIO_SESSION_ALLOCATE, AudioRecord::TRANSFER_SYNC,
                           AUDIO_INPUT_FLAG_NONE, attr.uid, attr.pid, &attrs);
    if (st != NO_ERROR) {
        say("error the audio system wouldn't open the call (%d)", st);
        return nullptr;
    }
    st = rec->start();
    if (st != NO_ERROR) {
        say("error the audio system wouldn't start the recording (%d)", st);
        return nullptr;
    }
    return rec;
}

template <typename File>
int record(AudioRecord & rec, File & file, const char * type, const char * ext) {
    if (!file.open()) {
        rec.stop();
        say("error couldn't write the file");
        return 1;
    }
    say("recording %s %s", type, ext);
    static int16_t buf[kChunk];
    uint64_t samples = 0;
    int peak = 0;
    const char * ended = "stopped";
    bool ok = true;
    while (!told_to_stop()) {
        if (samples >= kMaxSamples) {
            ended = "time limit";
            break;
        }
        ssize_t n = rec.read(buf, sizeof buf, true);
        if (n < 0) {
            ended = "read error";
            break;
        }
        size_t got = (size_t) n / 2;
        for (size_t i = 0; i < got; i++) {
            int s = buf[i] < 0 ? -buf[i] : buf[i];
            if (s > peak) {
                peak = s > 32767 ? 32767 : s;
            }
        }
        if (got && !file.write(buf, got)) {
            ended = "write error";
            ok = false;
            break;
        }
        samples += got;
    }
    rec.stop();
    fprintf(stderr, "callcap: recorded %llu s (%s), peak %d\n", (unsigned long long) (samples / kRate), ended,
            peak);
    if (!file.close() || !ok) {
        say("error the file couldn't be finished (%s)", ended);
        return 1;
    }
    say("done %llu %d", (unsigned long long) ((samples + kRate / 2) / kRate), peak);
    return 0;
}

}  // namespace

int main() {
    signal(SIGPIPE, SIG_IGN);
    if (lseek(kOut, 0, SEEK_CUR) < 0) {
        say("error no file to record into");
        return 1;
    }
    ProcessState::self()->startThreadPool();

    // a stack copy of this crashed in libaudioclient
    auto attr = std::make_unique<content::AttributionSourceState>();
    attr->uid = getuid();
    attr->pid = getpid();
    attr->deviceId = 0;

    sp<AudioRecord> rec = open_call(*attr);
    int rc = 1;
    if (rec != nullptr) {
        Aac aac;
        if (aac.open()) {
            rc = record(*rec, aac, "audio/mp4", "m4a");
        } else {
            Wav wav;
            rc = record(*rec, wav, "audio/wav", "wav");
        }
    }
    // deleting the AudioRecord aborts
    _exit(rc);
}

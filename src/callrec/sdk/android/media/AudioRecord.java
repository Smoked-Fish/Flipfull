package android.media;

import android.content.AttributionSource;
import android.content.Context;

public class AudioRecord {
    private final AudioFormat format;
    private long startedAt = -1;
    private long produced;
    private int state = 1;

    AudioRecord(AudioFormat format) {
        this.format = format;
    }

    public static int getMinBufferSize(int rate, int channelConfig, int encoding) {
        return 1280;
    }

    public void startRecording() {
        startedAt = System.currentTimeMillis();
        state = 3;
    }

    public int getRecordingState() {
        return state;
    }

    public int read(byte[] buf, int off, int size, int mode) {
        long elapsed = System.currentTimeMillis() - startedAt;
        String err = System.getProperty("fake.readerror");
        if (err != null && elapsed > Long.parseLong(err)) {
            return -3;
        }
        long due = elapsed * format.rate / 1000 - produced;
        int n = (int) Math.min(due, size / 2);
        for (int i = 0; i < n; i++) {
            short s = (short) (8000 * Math.sin(2 * Math.PI * 440 * (produced + i) / format.rate));
            buf[off + 2 * i] = (byte) s;
            buf[off + 2 * i + 1] = (byte) (s >> 8);
        }
        produced += n;
        return n * 2;
    }

    public void stop() {
        state = 1;
    }

    public void release() {
    }

    public static class Builder {
        private AudioAttributes attributes;
        private AudioFormat format;
        private Context context;

        public Builder setAudioAttributes(AudioAttributes attributes) {
            this.attributes = attributes;
            return this;
        }

        public Builder setAudioFormat(AudioFormat format) {
            this.format = format;
            return this;
        }

        public Builder setBufferSizeInBytes(int size) {
            return this;
        }

        public Builder setContext(Context context) {
            this.context = java.util.Objects.requireNonNull(context);
            return this;
        }

        public AudioRecord build() {
            AttributionSource source = context.getAttributionSource();
            if (source == null || context.getDeviceId() != 0) {
                throw new UnsupportedOperationException("bad context");
            }
            if ("fail".equals(System.getProperty("fake.open")) || attributes.source != 4) {
                throw new UnsupportedOperationException("Cannot create AudioRecord");
            }
            return new AudioRecord(format);
        }
    }
}

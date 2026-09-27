package android.media;

public final class AudioFormat {
    final int encoding;
    final int rate;
    final int channelMask;

    AudioFormat(int encoding, int rate, int channelMask) {
        this.encoding = encoding;
        this.rate = rate;
        this.channelMask = channelMask;
    }

    public static class Builder {
        private int encoding;
        private int rate;
        private int channelMask;

        public Builder setEncoding(int encoding) {
            this.encoding = encoding;
            return this;
        }

        public Builder setSampleRate(int rate) {
            this.rate = rate;
            return this;
        }

        public Builder setChannelMask(int channelMask) {
            this.channelMask = channelMask;
            return this;
        }

        public AudioFormat build() {
            return new AudioFormat(encoding, rate, channelMask);
        }
    }
}

package android.media;

public final class AudioAttributes {
    final int source;

    AudioAttributes(int source) {
        this.source = source;
    }

    public static class Builder {
        private int source;

        public Builder setInternalCapturePreset(int preset) {
            source = preset;
            return this;
        }

        public AudioAttributes build() {
            return new AudioAttributes(source);
        }
    }
}

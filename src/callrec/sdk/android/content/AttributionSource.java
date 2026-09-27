package android.content;

public final class AttributionSource {
    public final int uid;
    public final int pid;

    AttributionSource(int uid, int pid) {
        this.uid = uid;
        this.pid = pid;
    }

    public static final class Builder {
        private final int uid;
        private int pid = -1;

        public Builder(int uid) {
            this.uid = uid;
        }

        public Builder setPid(int pid) {
            this.pid = pid;
            return this;
        }

        public AttributionSource build() {
            return new AttributionSource(uid, pid);
        }
    }
}

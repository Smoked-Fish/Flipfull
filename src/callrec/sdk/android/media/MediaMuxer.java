package android.media;

import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;

public final class MediaMuxer {
    private final FileOutputStream out;
    private boolean started;

    public MediaMuxer(String path, int format) throws IOException {
        out = new FileOutputStream(path);
    }

    public int addTrack(MediaFormat format) {
        return 0;
    }

    public void start() {
        started = true;
    }

    public void writeSampleData(int track, ByteBuffer data, MediaCodec.BufferInfo info) {
        if (!started) {
            throw new IllegalStateException("Muxer is not started");
        }
        byte[] b = new byte[data.remaining()];
        data.get(b);
        try {
            out.write(b);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    public void stop() {
        started = false;
    }

    public void release() {
        try {
            out.close();
        } catch (IOException ignored) {}
    }
}

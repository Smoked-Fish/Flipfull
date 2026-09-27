package android.media;

import android.view.Surface;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;

public final class MediaCodec {
    public static final class BufferInfo {
        public int offset;
        public int size;
        public long presentationTimeUs;
        public int flags;
    }

    private final ByteBuffer[] in = {ByteBuffer.allocate(2048), ByteBuffer.allocate(2048)};
    private final ArrayDeque<Integer> freeIn = new ArrayDeque<>();
    private final ArrayDeque<Object[]> out = new ArrayDeque<>();
    private ByteBuffer current;
    private boolean formatSent;

    private MediaCodec() {
        freeIn.add(0);
        freeIn.add(1);
        out.add(new Object[] {new byte[] {0x12, 0x10}, 2, 0L});
    }

    public static MediaCodec createEncoderByType(String type) throws IOException {
        if (!"copy".equals(System.getProperty("fake.codec"))) {
            throw new IOException("no encoder for " + type + " (desktop stand-in)");
        }
        return new MediaCodec();
    }

    public void configure(MediaFormat format, Surface surface, MediaCrypto crypto, int flags) {
    }

    public void start() {
    }

    public void stop() {
    }

    public void release() {
    }

    public int dequeueInputBuffer(long timeoutUs) {
        Integer i = freeIn.poll();
        return i == null ? -1 : i;
    }

    public ByteBuffer getInputBuffer(int index) {
        return in[index];
    }

    public void queueInputBuffer(int index, int offset, int size, long pts, int flags) {
        byte[] b = new byte[size];
        in[index].flip();
        in[index].get(b);
        out.add(new Object[] {b, flags, pts});
        freeIn.add(index);
    }

    public int dequeueOutputBuffer(BufferInfo info, long timeoutUs) {
        if (!formatSent) {
            formatSent = true;
            return -2;
        }
        Object[] o = out.poll();
        if (o == null) {
            return -1;
        }
        byte[] b = (byte[]) o[0];
        current = ByteBuffer.wrap(b);
        info.offset = 0;
        info.size = b.length;
        info.flags = (Integer) o[1];
        info.presentationTimeUs = (Long) o[2];
        return 0;
    }

    public ByteBuffer getOutputBuffer(int index) {
        return current;
    }

    public void releaseOutputBuffer(int index, boolean render) {
    }

    public MediaFormat getOutputFormat() {
        return MediaFormat.createAudioFormat("audio/mp4a-latm", 16000, 1);
    }
}

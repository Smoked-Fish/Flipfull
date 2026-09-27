import android.content.AttributionSource;
import android.content.Context;
import android.content.ContextWrapper;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaFormat;
import android.media.MediaMuxer;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

public class CallRec {
    static final int VOICE_CALL = 4;
    static final int ENCODING_PCM_16BIT = 2;
    static final int CHANNEL_IN_MONO = 0x10;
    static final int READ_NON_BLOCKING = 1;
    static final int RECORDSTATE_RECORDING = 3;
    static final int DEVICE_ID_DEFAULT = 0;
    static final int CONFIGURE_FLAG_ENCODE = 1;
    static final int BUFFER_FLAG_CODEC_CONFIG = 2;
    static final int BUFFER_FLAG_END_OF_STREAM = 4;
    static final int INFO_OUTPUT_FORMAT_CHANGED = -2;
    static final int MUXER_OUTPUT_MPEG_4 = 0;
    static final int AAC_OBJECT_LC = 2;

    static final int RATE = 16000;
    static final int AAC_BITRATE = 32000;
    static final long MAX_MS = 4 * 3600 * 1000L;

    public static void main(String[] args) {
        File dir = new File(args.length > 0 ? args[0] : "/data/local/tmp/callrec");
        File state = new File(dir, "state");
        try {
            record(dir, state);
        } catch (Throwable t) {
            t.printStackTrace();
            writeState(state, "error " + describe(t));
        }
        System.exit(0);
    }

    static void record(File dir, File state) throws Exception {
        File wavFile = new File(dir, "rec.wav");
        File stop = new File(dir, "stop");

        AudioRecord rec = new AudioRecord.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setInternalCapturePreset(VOICE_CALL).build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(ENCODING_PCM_16BIT)
                        .setSampleRate(RATE)
                        .setChannelMask(CHANNEL_IN_MONO).build())
                .setBufferSizeInBytes(Math.max(
                        AudioRecord.getMinBufferSize(RATE, CHANNEL_IN_MONO, ENCODING_PCM_16BIT),
                        RATE * 2))
                .setContext(identity())
                .build();
        Level level = new Level();
        String ended = "stopped";
        long started;
        try (Wav wav = new Wav(wavFile, RATE)) {
            rec.startRecording();
            if (rec.getRecordingState() != RECORDSTATE_RECORDING) {
                throw new IOException("the audio system didn't start the recording");
            }
            writeState(state, "recording");
            started = System.currentTimeMillis();
            byte[] buf = new byte[RATE / 10 * 2];
            while (!stop.exists()) {
                if (System.currentTimeMillis() - started > MAX_MS) {
                    ended = "time limit";
                    break;
                }
                int n = rec.read(buf, 0, buf.length, READ_NON_BLOCKING);
                if (n < 0) {
                    ended = "read error " + n;
                    break;
                }
                if (n == 0) {
                    Thread.sleep(20);
                    continue;
                }
                wav.write(buf, n);
                level.add(buf, n);
            }
        } finally {
            try {
                rec.stop();
            } catch (Throwable ignored) {}
            rec.release();
        }
        long seconds = Math.round((wavFile.length() - 44) / (RATE * 2.0));
        System.out.println("recorded " + seconds + " s (" + ended + "), peak " + level.peak);

        String result;
        File m4a = new File(dir, "rec.m4a");
        try {
            encodeAac(wavFile, m4a);
            wavFile.delete();
            result = "rec.m4a audio/mp4";
        } catch (Throwable t) {
            System.out.println("AAC encoding failed, keeping the WAV: " + describe(t));
            m4a.delete();
            result = "rec.wav audio/wav";
        }
        writeState(state, "done " + result + " " + seconds + " " + level.peak);
    }

    static Context identity() {
        final AttributionSource source = new AttributionSource.Builder(android.os.Process.myUid())
                .setPid(android.os.Process.myPid())
                .build();
        return new ContextWrapper(null) {
            @Override
            public AttributionSource getAttributionSource() {
                return source;
            }

            @Override
            public int getDeviceId() {
                return DEVICE_ID_DEFAULT;
            }
        };
    }

    static class Wav implements AutoCloseable {
        final RandomAccessFile f;
        final int rate;
        long bytes;

        Wav(File file, int rate) throws IOException {
            this.rate = rate;
            f = new RandomAccessFile(file, "rw");
            f.setLength(0);
            f.write(header(0));
        }

        void write(byte[] b, int n) throws IOException {
            f.write(b, 0, n);
            bytes += n;
        }

        byte[] header(long dataBytes) {
            ByteBuffer h = ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
            h.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt((int) (36 + dataBytes));
            h.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16);
            h.putShort((short) 1).putShort((short) 1);
            h.putInt(rate).putInt(rate * 2).putShort((short) 2).putShort((short) 16);
            h.put("data".getBytes(StandardCharsets.US_ASCII)).putInt((int) dataBytes);
            return h.array();
        }

        @Override
        public void close() throws IOException {
            f.seek(0);
            f.write(header(bytes));
            f.close();
        }
    }

    static class Level {
        int peak;

        void add(byte[] b, int n) {
            for (int i = 0; i + 1 < n; i += 2) {
                int s = Math.abs((short) ((b[i] & 0xff) | (b[i + 1] << 8)));
                if (s > peak) {
                    peak = Math.min(s, 32767);
                }
            }
        }
    }

    static void encodeAac(File wav, File out) throws Exception {
        MediaFormat format = MediaFormat.createAudioFormat("audio/mp4a-latm", RATE, 1);
        format.setInteger("aac-profile", AAC_OBJECT_LC);
        format.setInteger("bitrate", AAC_BITRATE);
        format.setInteger("max-input-size", 8192);
        MediaCodec codec = MediaCodec.createEncoderByType("audio/mp4a-latm");
        MediaMuxer muxer = null;
        boolean muxing = false;
        try (InputStream in = new FileInputStream(wav)) {
            readFully(in, new byte[44], 44);
            codec.configure(format, null, null, CONFIGURE_FLAG_ENCODE);
            codec.start();
            muxer = new MediaMuxer(out.getPath(), MUXER_OUTPUT_MPEG_4);
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            byte[] chunk = new byte[4096];
            long samples = 0;
            int track = -1;
            boolean inputDone = false;
            long lastProgress = System.currentTimeMillis();
            while (true) {
                if (!inputDone) {
                    int i = codec.dequeueInputBuffer(10000);
                    if (i >= 0) {
                        ByteBuffer b = codec.getInputBuffer(i);
                        b.clear();
                        int n = readFully(in, chunk, Math.min(chunk.length, b.remaining()) & ~1);
                        long pts = samples * 1000000L / RATE;
                        if (n <= 0) {
                            codec.queueInputBuffer(i, 0, 0, pts, BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            b.put(chunk, 0, n);
                            codec.queueInputBuffer(i, 0, n, pts, 0);
                            samples += n / 2;
                        }
                        lastProgress = System.currentTimeMillis();
                    }
                }
                int o = codec.dequeueOutputBuffer(info, 10000);
                if (o == INFO_OUTPUT_FORMAT_CHANGED) {
                    track = muxer.addTrack(codec.getOutputFormat());
                    muxer.start();
                    muxing = true;
                } else if (o >= 0) {
                    ByteBuffer b = codec.getOutputBuffer(o);
                    if ((info.flags & BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0 && muxing) {
                        b.position(info.offset);
                        b.limit(info.offset + info.size);
                        muxer.writeSampleData(track, b, info);
                    }
                    codec.releaseOutputBuffer(o, false);
                    lastProgress = System.currentTimeMillis();
                    if ((info.flags & BUFFER_FLAG_END_OF_STREAM) != 0) {
                        break;
                    }
                }
                if (System.currentTimeMillis() - lastProgress > 10000) {
                    throw new IOException("the encoder stopped responding");
                }
            }
            if (!muxing) {
                throw new IOException("the encoder produced nothing");
            }
            muxer.stop();
        } finally {
            try {
                codec.stop();
            } catch (Throwable ignored) {}
            codec.release();
            if (muxer != null) {
                try {
                    muxer.release();
                } catch (Throwable ignored) {}
            }
        }
    }

    static int readFully(InputStream in, byte[] b, int n) throws IOException {
        int got = 0;
        while (got < n) {
            int r = in.read(b, got, n - got);
            if (r < 0) {
                break;
            }
            got += r;
        }
        return got & ~1;
    }

    static void writeState(File state, String text) {
        File tmp = new File(state.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write((text + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            e.printStackTrace();
            return;
        }
        if (!tmp.renameTo(state)) {
            System.err.println("can't write " + state);
        }
    }

    static String describe(Throwable t) {
        Throwable c = t;
        while (c.getCause() != null) {
            c = c.getCause();
        }
        String msg = c.getClass().getSimpleName() + ": " + c.getMessage();
        return msg.replace('\n', ' ');
    }
}

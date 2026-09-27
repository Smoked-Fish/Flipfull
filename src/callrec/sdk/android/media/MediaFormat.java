package android.media;

import java.util.HashMap;
import java.util.Map;

public final class MediaFormat {
    final Map<String, Object> map = new HashMap<>();

    public static MediaFormat createAudioFormat(String mime, int rate, int channels) {
        MediaFormat f = new MediaFormat();
        f.map.put("mime", mime);
        f.map.put("sample-rate", rate);
        f.map.put("channel-count", channels);
        return f;
    }

    public void setInteger(String name, int value) {
        map.put(name, value);
    }
}

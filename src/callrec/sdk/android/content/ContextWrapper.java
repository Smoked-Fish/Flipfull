package android.content;

public class ContextWrapper extends Context {
    Context mBase;

    public ContextWrapper(Context base) {
        mBase = base;
    }

    @Override
    public AttributionSource getAttributionSource() {
        return mBase.getAttributionSource();
    }

    @Override
    public int getDeviceId() {
        return mBase.getDeviceId();
    }
}

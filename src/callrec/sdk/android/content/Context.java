package android.content;

public abstract class Context {
    public AttributionSource getAttributionSource() {
        throw new RuntimeException("Not implemented. Must override in a subclass.");
    }

    public int getDeviceId() {
        throw new RuntimeException("Not implemented. Must override in a subclass.");
    }
}

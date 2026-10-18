package site.loomail;

import java.util.Map;

/** One identify or track in {@link Loomail#batch}. Make them with {@link #identify} and {@link #track}. */
public final class BatchItem {
    private final boolean identify;
    private final String userId;
    private final String event;
    private final Map<String, ?> data;
    private final CallOptions options;

    private BatchItem(boolean identify, String userId, String event, Map<String, ?> data, CallOptions options) {
        this.identify = identify;
        this.userId = userId;
        this.event = event;
        this.data = data;
        this.options = options == null ? CallOptions.none() : options;
    }

    public static BatchItem identify(String userId, Map<String, ?> traits) {
        return identify(userId, traits, CallOptions.none());
    }

    public static BatchItem identify(String userId, Map<String, ?> traits, CallOptions options) {
        return new BatchItem(true, userId, null, traits, options);
    }

    public static BatchItem track(String userId, String event, Map<String, ?> properties) {
        return track(userId, event, properties, CallOptions.none());
    }

    public static BatchItem track(String userId, String event, Map<String, ?> properties, CallOptions options) {
        return new BatchItem(false, userId, event, properties, options);
    }

    boolean isIdentify() {
        return identify;
    }

    String userId() {
        return userId;
    }

    String event() {
        return event;
    }

    /** The traits (identify) or properties (track). */
    Map<String, ?> data() {
        return data;
    }

    CallOptions options() {
        return options;
    }
}

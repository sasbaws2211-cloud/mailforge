package site.loomail;

import java.time.Instant;
import java.util.Map;

/** The optional parts of a call. Build one with {@link #builder()}; {@link #none()} has none of them. */
public final class CallOptions {
    private static final CallOptions NONE = new CallOptions(null, null, null);

    private final Instant timestamp;
    private final String messageId;
    private final Map<String, ?> context;

    private CallOptions(Instant timestamp, String messageId, Map<String, ?> context) {
        this.timestamp = timestamp;
        this.messageId = messageId;
        this.context = context;
    }

    /** No options: now, a generated messageId, no context. */
    public static CallOptions none() {
        return NONE;
    }

    public static Builder builder() {
        return new Builder();
    }

    /** When it happened. Loomail re-dates anything more than 72 hours from its own clock. */
    public Instant timestamp() {
        return timestamp;
    }

    /** Your own idempotency key, such as {@code "paid:" + invoiceId}. Generated when null. */
    public String messageId() {
        return messageId;
    }

    /** Extra data stored with the event (ip, userAgent, anything else). */
    public Map<String, ?> context() {
        return context;
    }

    public static final class Builder {
        private Instant timestamp;
        private String messageId;
        private Map<String, ?> context;

        private Builder() {
        }

        public Builder timestamp(Instant timestamp) {
            this.timestamp = timestamp;
            return this;
        }

        public Builder messageId(String messageId) {
            this.messageId = messageId;
            return this;
        }

        public Builder context(Map<String, ?> context) {
            this.context = context;
            return this;
        }

        public CallOptions build() {
            return new CallOptions(timestamp, messageId, context);
        }
    }
}

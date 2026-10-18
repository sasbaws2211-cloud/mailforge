package site.loomail;

/** What identify and track return. */
public final class CallResult {
    private final boolean deduplicated;

    CallResult(boolean deduplicated) {
        this.deduplicated = deduplicated;
    }

    /** True when Loomail had already seen this messageId and ignored the repeat. */
    public boolean deduplicated() {
        return deduplicated;
    }

    @Override
    public String toString() {
        return "CallResult{deduplicated=" + deduplicated + "}";
    }
}

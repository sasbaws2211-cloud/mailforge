package site.loomail;

/**
 * Thrown when Loomail cannot be reached or refuses a call. {@link #code()} says what kind of failure it is.
 */
public final class LoomailException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    /** What kind of failure. */
    public enum Code {
        /** Caught before any request was made. */
        INVALID_ARGUMENT,
        /** 401: the key is missing, wrong or revoked. */
        UNAUTHORIZED,
        /** 403: the key is not allowed here. */
        FORBIDDEN,
        /** 402: the workspace is at its contact limit. */
        PLAN_LIMIT,
        /** 400 or 422: Loomail did not accept the payload. */
        VALIDATION,
        /** 429, still failing after retries. */
        RATE_LIMITED,
        /** 5xx, still failing after retries. */
        SERVER,
        /** Loomail could not be reached, or did not answer in time. */
        NETWORK
    }

    private final Code code;
    private final int status;
    private final transient Object body;

    LoomailException(Code code, String message) {
        this(code, message, 0, null, null);
    }

    LoomailException(Code code, String message, int status, Object body, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.status = status;
        this.body = body;
    }

    /** What kind of failure this is. */
    public Code code() {
        return code;
    }

    /** The HTTP status Loomail answered with, or 0 when it did not (invalid argument, network). */
    public int status() {
        return status;
    }

    /** The parsed response body (a {@code Map}, or the raw text when it was not JSON), or null. */
    public Object body() {
        return body;
    }
}

package site.loomail;

import java.util.List;

/** What {@link Loomail#batch} returns. */
public final class BatchResult {
    private final int received;
    private final List<Error> errors;

    BatchResult(int received, List<Error> errors) {
        this.received = received;
        this.errors = errors;
    }

    /** Items Loomail accepted (a repeat of a messageId counts as accepted). */
    public int received() {
        return received;
    }

    /** Items Loomail refused. The rest of the batch is unaffected. */
    public List<Error> errors() {
        return errors;
    }

    /** An item Loomail refused. */
    public static final class Error {
        private final int index;
        private final String message;
        private final String code;

        Error(int index, String message, String code) {
            this.index = index;
            this.message = message;
            this.code = code;
        }

        /** The item's position in the list you passed. */
        public int index() {
            return index;
        }

        public String message() {
            return message;
        }

        /** "plan_limit" when the item was refused because the workspace is at its contact limit; otherwise null. */
        public String code() {
            return code;
        }

        @Override
        public String toString() {
            return "Error{index=" + index + ", message=" + message + ", code=" + code + "}";
        }
    }
}

package site.loomail;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A small JSON writer and parser, so the client needs no dependency. Not part of the public API. */
final class Json {
    private Json() {
    }

    // -- writing ----------------------------------------------------------

    static String write(Object value) {
        StringBuilder sb = new StringBuilder(256);
        write(sb, value);
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof CharSequence) {
            string(sb, v.toString());
        } else if (v instanceof Boolean) {
            sb.append(v.toString());
        } else if (v instanceof Number) {
            number(sb, (Number) v);
        } else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                string(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof Collection) {
            sb.append('[');
            boolean first = true;
            for (Object item : (Collection<?>) v) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                write(sb, item);
            }
            sb.append(']');
        } else if (v instanceof Object[]) {
            sb.append('[');
            Object[] arr = (Object[]) v;
            for (int i = 0; i < arr.length; i++) {
                if (i > 0) {
                    sb.append(',');
                }
                write(sb, arr[i]);
            }
            sb.append(']');
        } else if (v instanceof Instant) {
            string(sb, DateTimeFormatter.ISO_INSTANT.format((Instant) v));
        } else if (v instanceof Date) {
            string(sb, DateTimeFormatter.ISO_INSTANT.format(((Date) v).toInstant()));
        } else if (v instanceof OffsetDateTime) {
            string(sb, DateTimeFormatter.ISO_INSTANT.format(((OffsetDateTime) v).toInstant()));
        } else if (v instanceof ZonedDateTime) {
            string(sb, DateTimeFormatter.ISO_INSTANT.format(((ZonedDateTime) v).toInstant()));
        } else if (v instanceof Enum) {
            string(sb, ((Enum<?>) v).name());
        } else {
            throw new IllegalArgumentException("cannot encode " + v.getClass().getName() + " as JSON (use Map, List, String, Number, Boolean, Instant)");
        }
    }

    private static void number(StringBuilder sb, Number n) {
        if (n instanceof Double || n instanceof Float) {
            double d = n.doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) {
                throw new IllegalArgumentException("NaN and infinity cannot be encoded as JSON");
            }
        }
        sb.append(n.toString());
    }

    private static void string(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else if (Character.isHighSurrogate(c)) {
                        if (i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1))) {
                            throw new IllegalArgumentException("text contains an unpaired surrogate");
                        }
                        sb.append(c).append(s.charAt(++i));
                    } else if (Character.isLowSurrogate(c)) {
                        throw new IllegalArgumentException("text contains an unpaired surrogate");
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // -- parsing ----------------------------------------------------------

    /** Parses JSON into Map (insertion ordered), List, String, Long, Double, Boolean or null. */
    static Object parse(String text) {
        Parser p = new Parser(text);
        p.skip();
        Object v = p.value();
        p.skip();
        if (p.i != text.length()) {
            throw new IllegalArgumentException("unexpected text after the JSON value");
        }
        return v;
    }

    private static final class Parser {
        final String s;
        int i;

        Parser(String s) {
            this.s = s;
        }

        void skip() {
            while (i < s.length() && (s.charAt(i) == ' ' || s.charAt(i) == '\n' || s.charAt(i) == '\r' || s.charAt(i) == '\t')) {
                i++;
            }
        }

        char peek() {
            if (i >= s.length()) {
                throw new IllegalArgumentException("unexpected end of JSON");
            }
            return s.charAt(i);
        }

        Object value() {
            char c = peek();
            if (c == '{') {
                return object();
            }
            if (c == '[') {
                return array();
            }
            if (c == '"') {
                return string();
            }
            if (s.startsWith("true", i)) {
                i += 4;
                return Boolean.TRUE;
            }
            if (s.startsWith("false", i)) {
                i += 5;
                return Boolean.FALSE;
            }
            if (s.startsWith("null", i)) {
                i += 4;
                return null;
            }
            return number();
        }

        Map<String, Object> object() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++; // {
            skip();
            if (peek() == '}') {
                i++;
                return m;
            }
            while (true) {
                skip();
                if (peek() != '"') {
                    throw new IllegalArgumentException("expected a string key");
                }
                String k = string();
                skip();
                if (peek() != ':') {
                    throw new IllegalArgumentException("expected ':'");
                }
                i++;
                skip();
                m.put(k, value());
                skip();
                char c = peek();
                i++;
                if (c == '}') {
                    return m;
                }
                if (c != ',') {
                    throw new IllegalArgumentException("expected ',' or '}'");
                }
            }
        }

        List<Object> array() {
            List<Object> l = new ArrayList<>();
            i++; // [
            skip();
            if (peek() == ']') {
                i++;
                return l;
            }
            while (true) {
                skip();
                l.add(value());
                skip();
                char c = peek();
                i++;
                if (c == ']') {
                    return l;
                }
                if (c != ',') {
                    throw new IllegalArgumentException("expected ',' or ']'");
                }
            }
        }

        String string() {
            StringBuilder sb = new StringBuilder();
            i++; // opening quote
            while (true) {
                char c = peek();
                i++;
                if (c == '"') {
                    return sb.toString();
                }
                if (c != '\\') {
                    sb.append(c);
                    continue;
                }
                char e = peek();
                i++;
                switch (e) {
                    case '"':
                    case '\\':
                    case '/':
                        sb.append(e);
                        break;
                    case 'n':
                        sb.append('\n');
                        break;
                    case 'r':
                        sb.append('\r');
                        break;
                    case 't':
                        sb.append('\t');
                        break;
                    case 'b':
                        sb.append('\b');
                        break;
                    case 'f':
                        sb.append('\f');
                        break;
                    case 'u':
                        if (i + 4 > s.length()) {
                            throw new IllegalArgumentException("bad \\u escape");
                        }
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                        break;
                    default:
                        throw new IllegalArgumentException("bad escape \\" + e);
                }
            }
        }

        Object number() {
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
            String t = s.substring(start, i);
            if (t.isEmpty()) {
                throw new IllegalArgumentException("unexpected character '" + peek() + "'");
            }
            if (t.indexOf('.') < 0 && t.indexOf('e') < 0 && t.indexOf('E') < 0) {
                try {
                    return Long.parseLong(t);
                } catch (NumberFormatException ignored) {
                    // too big for a long: fall through to double
                }
            }
            return Double.parseDouble(t);
        }
    }
}

package site.loomail;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JsonTest {
    @Test
    void writesScalarsMapsListsAndDates() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("s", "a\"b");
        m.put("n", 1);
        m.put("d", 1.5);
        m.put("l", 3_000_000_000L);
        m.put("b", false);
        m.put("z", null);
        m.put("list", List.of(1, "x", List.of()));
        m.put("arr", new String[] {"p", "q"});
        m.put("t", Instant.parse("2026-05-01T10:00:00Z"));
        m.put("big", new BigDecimal("12.50"));
        assertEquals("{\"s\":\"a\\\"b\",\"n\":1,\"d\":1.5,\"l\":3000000000,\"b\":false,\"z\":null,\"list\":[1,\"x\",[]],\"arr\":[\"p\",\"q\"],\"t\":\"2026-05-01T10:00:00Z\",\"big\":12.50}", Json.write(m));
    }

    @Test
    void escapesControlCharactersButNotUnicode() {
        assertEquals("\"\\u0001\\n\\t\\\\é日\uD83D\uDE00\"", Json.write("\u0001\n\t\\é日\uD83D\uDE00"));
    }

    @Test
    void refusesWhatJsonCannotHold() {
        assertThrows(IllegalArgumentException.class, () -> Json.write(Double.POSITIVE_INFINITY));
        assertThrows(IllegalArgumentException.class, () -> Json.write("\uDC00"));
        assertThrows(IllegalArgumentException.class, () -> Json.write(new Object()));
    }

    @Test
    void parsesWhatItWrites() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("a", List.of(1L, 2.5, "x", true, false));
        m.put("b", Map.of("c", "d"));
        m.put("e", "é\n\"");
        assertEquals(m, Json.parse(Json.write(m)));
    }

    @Test
    void parsesNumbersEscapesWhitespaceAndNull() {
        assertEquals(Arrays.asList(1L, -2L, 3.5, 1e3, null), Json.parse(" [ 1 , -2 , 3.5 , 1e3 , null ] "));
        assertEquals("A/\u00e9", Json.parse("\"\\u0041\\/\\u00e9\""));
        assertEquals(9_223_372_036_854_775_808.0, Json.parse("9223372036854775808"));
        assertNull(Json.parse("null"));
        assertEquals(new LinkedHashMap<>(), Json.parse("{}"));
        assertEquals(new ArrayList<>(), Json.parse("[]"));
    }

    @Test
    void rejectsBrokenJson() {
        for (String bad : new String[] {"", "{", "[1,", "{\"a\"}", "{\"a\":1,}", "[1 2]", "\"abc", "tru", "{} x", "\"\\q\""}) {
            assertThrows(IllegalArgumentException.class, () -> Json.parse(bad), bad);
        }
    }
}

// Sends a few events to a real Loomail.
// Usage (from packages/sdk-java, after `mvn package`):
//   LOOMAIL_SECRET_KEY=mf_live_... LOOMAIL_HOST=http://localhost:3000 java -cp target/classes examples/Quickstart.java [prefix]
import java.time.Instant;
import java.util.List;
import java.util.Map;
import site.loomail.BatchItem;
import site.loomail.BatchResult;
import site.loomail.CallOptions;
import site.loomail.CallResult;
import site.loomail.Loomail;
import site.loomail.LoomailException;

public class Quickstart {
    public static void main(String[] args) {
        String prefix = args.length > 0 ? args[0] : "java";
        String id = prefix + "_user";
        Loomail loomail = Loomail.fromEnvironment();

        loomail.identify(id, Map.of("email", prefix + "@example.com", "plan", "trial", "n", 1));
        CallOptions once = CallOptions.builder().messageId("su:" + prefix).build();
        CallResult first = loomail.track(id, "signed_up", Map.of("source", prefix), once);
        CallResult again = loomail.track(id, "signed_up", Map.of("source", prefix), once);
        System.out.println("deduplicated first=" + first.deduplicated() + " again=" + again.deduplicated());

        BatchResult res = loomail.batch(List.of(
                BatchItem.identify(id, Map.of("plan", "pro")),
                BatchItem.track(id, "upgraded", Map.of("plan", "pro"), CallOptions.builder().timestamp(Instant.now().minusSeconds(3600)).build()),
                BatchItem.track(id, "viewed", null)));
        System.out.println("batch received=" + res.received() + " errors=" + res.errors().size());

        try {
            Loomail.builder().secretKey("mf_live_wrong").maxRetries(0).build().track(id, "nope", Map.of());
        } catch (LoomailException e) {
            System.out.println("bad key => " + e.code().name().toLowerCase() + " " + e.status());
        }
    }
}

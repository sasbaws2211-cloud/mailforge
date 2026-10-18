// Sends a few events to a real Loomail.
// Usage: LOOMAIL_SECRET_KEY=mf_live_... LOOMAIL_HOST=http://localhost:3000 go run ./examples/quickstart [prefix]
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	loomail "github.com/sasbaws2211-cloud/mailforge/packages/sdk-go"
)

func main() {
	prefix := "go"
	if len(os.Args) > 1 {
		prefix = os.Args[1]
	}
	id := prefix + "_user"
	ctx := context.Background()

	client, err := loomail.New()
	if err != nil {
		log.Fatal(err)
	}
	if _, err := client.Identify(ctx, id, map[string]any{"email": prefix + "@example.com", "plan": "trial", "n": 1}); err != nil {
		log.Fatal(err)
	}
	first, err := client.Track(ctx, id, "signed_up", map[string]any{"source": prefix}, loomail.WithMessageID("su:"+prefix))
	if err != nil {
		log.Fatal(err)
	}
	again, _ := client.Track(ctx, id, "signed_up", map[string]any{"source": prefix}, loomail.WithMessageID("su:"+prefix))
	fmt.Printf("deduplicated first=%v again=%v\n", first.Deduplicated, again.Deduplicated)

	res, err := client.Batch(ctx, []loomail.BatchItem{
		loomail.IdentifyItem(id, map[string]any{"plan": "pro"}),
		loomail.TrackItem(id, "upgraded", map[string]any{"plan": "pro"}, loomail.WithTimestamp(time.Now().Add(-time.Hour))),
		loomail.TrackItem(id, "viewed", nil),
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("batch received=%d errors=%d\n", res.Received, len(res.Errors))

	bad, _ := loomail.New(loomail.WithSecretKey("mf_live_wrong"), loomail.WithMaxRetries(0))
	_, err = bad.Track(ctx, id, "nope", nil)
	var le *loomail.Error
	if errors.As(err, &le) {
		fmt.Printf("bad key => %s %d\n", le.Code, le.Status)
	}
}

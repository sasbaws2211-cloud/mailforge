<?php
// Sends a few events to a real Loomail. Usage: LOOMAIL_SECRET_KEY=mf_live_... LOOMAIL_HOST=http://localhost:3000 php examples/quickstart.php [prefix]
require __DIR__ . '/../vendor/autoload.php';

use Loomail\Client;
use Loomail\LoomailException;

$p = $argv[1] ?? 'php';
$loomail = new Client();
$id = "{$p}_user";

$loomail->identify($id, ['email' => "{$p}@example.com", 'plan' => 'trial', 'n' => 1]);
$first = $loomail->track($id, 'signed_up', ['source' => $p], ['message_id' => "su:$p"]);
$again = $loomail->track($id, 'signed_up', ['source' => $p], ['message_id' => "su:$p"]);
echo "deduplicated first=" . var_export($first->deduplicated, true) . " again=" . var_export($again->deduplicated, true) . "\n";

$when = new DateTimeImmutable('-1 hour');
$res = $loomail->batch([
    ['type' => 'identify', 'user_id' => $id, 'traits' => ['plan' => 'pro']],
    ['type' => 'track', 'user_id' => $id, 'event' => 'upgraded', 'properties' => ['plan' => 'pro'], 'timestamp' => $when],
    ['type' => 'track', 'user_id' => $id, 'event' => 'viewed', 'properties' => []],
]);
echo "batch received={$res->received} errors=" . count($res->errors) . "\n";

try {
    (new Client(['secret_key' => 'mf_live_wrong', 'max_retries' => 0]))->track($id, 'nope');
} catch (LoomailException $e) {
    echo "bad key => {$e->errorCode} {$e->status}\n";
}

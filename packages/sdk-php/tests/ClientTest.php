<?php

declare(strict_types=1);

namespace Loomail\Tests;

use DateTimeImmutable;
use DateTimeZone;
use Loomail\Client;
use Loomail\LoomailException;
use Loomail\TransportException;
use PHPUnit\Framework\TestCase;

final class ClientTest extends TestCase
{
    /** @var list<float> */
    private array $waited = [];

    private function client(FakeTransport $t, array $extra = []): Client
    {
        $this->waited = [];
        return new Client($extra + [
            'secret_key' => 'mf_live_test',
            'host' => 'https://loomail.test/',
            'transport' => $t,
            'sleep' => function (float $s): void {
                $this->waited[] = $s;
            },
        ]);
    }

    private function expectError(string $code, callable $fn): LoomailException
    {
        try {
            $fn();
        } catch (LoomailException $e) {
            $this->assertSame($code, $e->errorCode, $e->getMessage());
            return $e;
        }
        $this->fail("expected a LoomailException ($code)");
    }

    public function testIdentifySendsBearerKeyTraitsAndGeneratedMessageId(): void
    {
        $t = new FakeTransport();
        $this->client($t)->identify('u1', ['email' => 'a@b.c', 'plan' => 'trial']);
        $r = $t->requests[0];
        $this->assertSame('https://loomail.test/v1/identify', $r['url']);
        $this->assertSame('Bearer mf_live_test', $r['headers']['Authorization']);
        $this->assertSame('application/json', $r['headers']['Content-Type']);
        $this->assertSame('u1', $r['json']->userId);
        $this->assertSame('a@b.c', $r['json']->traits->email);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $r['json']->messageId);
        $this->assertObjectNotHasProperty('timestamp', $r['json']);
        $this->assertObjectNotHasProperty('context', $r['json']);
    }

    public function testEmptyTraitsAndPropertiesAreObjectsNotArrays(): void
    {
        $t = new FakeTransport();
        $c = $this->client($t);
        $c->identify('u1');
        $c->track('u1', 'e', [], ['context' => []]);
        $this->assertStringContainsString('"traits":{}', $t->requests[0]['body']);
        $this->assertStringContainsString('"properties":{}', $t->requests[1]['body']);
        $this->assertStringContainsString('"context":{}', $t->requests[1]['body']);
    }

    public function testTrackSendsPropertiesContextAndUtcTimestampFromAnyTimezone(): void
    {
        $t = new FakeTransport();
        $when = new DateTimeImmutable('2026-05-01 12:00:00', new DateTimeZone('Europe/Athens')); // 09:00 UTC (summer time)
        $this->client($t)->track('u1', 'paid', ['amount' => 4900, 'tax' => 0.0], ['timestamp' => $when, 'context' => ['ip' => '1.2.3.4']]);
        $j = $t->requests[0]['json'];
        $this->assertSame('2026-05-01T09:00:00.000Z', $j->timestamp);
        $this->assertSame('paid', $j->event);
        $this->assertSame(4900, $j->properties->amount);
        $this->assertSame('1.2.3.4', $j->context->ip);
        $this->assertStringContainsString('"tax":0.0', $t->requests[0]['body']);
        // a string timestamp is accepted too
        $this->client($t)->track('u1', 'e', [], ['timestamp' => '2026-05-01T10:00:00+02:00']);
        $this->assertSame('2026-05-01T08:00:00.000Z', $t->requests[1]['json']->timestamp);
    }

    public function testUnicodeAndSlashesAreNotEscaped(): void
    {
        $t = new FakeTransport();
        $this->client($t)->track('u1', 'e', ['name' => 'Zoë 日本 a/b']);
        $this->assertStringContainsString('"name":"Zoë 日本 a/b"', $t->requests[0]['body']);
    }

    public function testOwnMessageIdAndDeduplicatedRepeat(): void
    {
        $t = new FakeTransport([['body' => ['success' => true, 'deduplicated' => true]]]);
        $r = $this->client($t)->track('u1', 'paid', [], ['message_id' => 'paid:inv_9']);
        $this->assertSame('paid:inv_9', $t->requests[0]['json']->messageId);
        $this->assertTrue($r->deduplicated);
        $this->assertFalse($this->client(new FakeTransport())->track('u1', 'e')->deduplicated);
    }

    public function testRejectsBadArgumentsBeforeAnyRequest(): void
    {
        $t = new FakeTransport();
        $c = $this->client($t);
        $this->expectError('invalid_argument', fn () => $c->identify('  '));
        $this->expectError('invalid_argument', fn () => $c->track('u1', ''));
        $this->expectError('invalid_argument', fn () => $c->track('u1', 'e', [], ['timestamp' => 'not a date']));
        $this->expectError('invalid_argument', fn () => $c->track('u1', 'e', ['bad' => "\xB1\x31"])); // invalid UTF-8
        $this->assertCount(0, $t->requests);
    }

    public function testRefusesAMissingOrPublishableKey(): void
    {
        putenv('LOOMAIL_SECRET_KEY');
        $this->expectError('invalid_argument', fn () => new Client());
        $e = $this->expectError('invalid_argument', fn () => new Client(['secret_key' => 'mf_pub_abc']));
        $this->assertStringContainsString('publishable', $e->getMessage());
    }

    public function testHostAndKeyFromEnvironment(): void
    {
        putenv('LOOMAIL_SECRET_KEY=mf_live_env');
        putenv('LOOMAIL_HOST=https://loomail.example.com///');
        try {
            $t = new FakeTransport();
            (new Client(['transport' => $t]))->track('u1', 'e');
            $this->assertSame('https://loomail.example.com/v1/track', $t->requests[0]['url']);
            $this->assertSame('Bearer mf_live_env', $t->requests[0]['headers']['Authorization']);
        } finally {
            putenv('LOOMAIL_SECRET_KEY');
            putenv('LOOMAIL_HOST');
        }
        $t = new FakeTransport();
        (new Client(['secret_key' => 'mf_live_x', 'transport' => $t]))->track('u1', 'e');
        $this->assertSame('https://loomail.site/v1/track', $t->requests[0]['url']);
    }

    public function testRetriesA503WithTheSameMessageIdThenSucceeds(): void
    {
        $t = new FakeTransport([['status' => 503, 'body' => ['error' => 'busy']], ['status' => 503, 'body' => '<html>'], ['body' => ['success' => true]]]);
        $this->client($t)->track('u1', 'e');
        $this->assertCount(3, $t->requests);
        $ids = array_map(static fn ($r) => $r['json']->messageId, $t->requests);
        $this->assertCount(1, array_unique($ids));
        $this->assertCount(2, $this->waited);
        $this->assertGreaterThanOrEqual(0.5, $this->waited[0]);
        $this->assertGreaterThanOrEqual(1.0, $this->waited[1]);
    }

    public function testHonoursRetryAfter(): void
    {
        $t = new FakeTransport([['status' => 429, 'headers' => ['retry-after' => '7'], 'body' => ['error' => 'slow']], ['body' => []]]);
        $this->client($t)->track('u1', 'e');
        $this->assertSame([7.0], $this->waited);
    }

    public function testGivesUpAfterMaxRetriesAndSaysWhy(): void
    {
        $t = new FakeTransport([['status' => 429, 'body' => ['error' => 'too many']]]);
        $e = $this->expectError('rate_limited', fn () => $this->client($t, ['max_retries' => 2])->track('u1', 'e'));
        $this->assertSame(429, $e->status);
        $this->assertSame(['error' => 'too many'], $e->body);
        $this->assertStringContainsString('too many', $e->getMessage());
        $this->assertCount(3, $t->requests);

        $t2 = new FakeTransport([['status' => 500, 'body' => '']]);
        $this->expectError('server', fn () => $this->client($t2, ['max_retries' => 0])->track('u1', 'e'));
        $this->assertCount(1, $t2->requests);
    }

    public function testDoesNotRetryAMistake(): void
    {
        foreach ([401 => 'unauthorized', 402 => 'plan_limit', 403 => 'forbidden', 400 => 'validation', 422 => 'validation'] as $status => $code) {
            $t = new FakeTransport([['status' => $status, 'body' => ['error' => 'no']]]);
            $this->expectError($code, fn () => $this->client($t)->track('u1', 'e'));
            $this->assertCount(1, $t->requests, "status $status");
        }
    }

    public function testNetworkFailureIsRetriedThenReported(): void
    {
        $t = new FakeTransport([new TransportException('Connection refused')]);
        $e = $this->expectError('network', fn () => $this->client($t, ['max_retries' => 1])->track('u1', 'e'));
        $this->assertStringContainsString('Connection refused', $e->getMessage());
        $this->assertInstanceOf(TransportException::class, $e->getPrevious());
        $this->assertCount(2, $t->requests);
    }

    public function testBatchSplitsIntoRequestsOf100AndOffsetsErrorIndexes(): void
    {
        $t = new FakeTransport([
            ['body' => ['received' => 100]],
            ['body' => ['received' => 99, 'errors' => [['index' => 3, 'message' => 'at limit', 'code' => 'plan_limit']]]],
            ['body' => ['received' => 50]],
        ]);
        $items = [];
        for ($i = 0; $i < 250; $i++) {
            $items[] = $i % 2 === 0
                ? ['type' => 'identify', 'user_id' => "u$i", 'traits' => ['n' => $i]]
                : ['type' => 'track', 'user_id' => "u$i", 'event' => 'e'];
        }
        $res = $this->client($t)->batch($items);
        $this->assertCount(3, $t->requests);
        $this->assertSame('https://loomail.test/v1/batch', $t->requests[0]['url']);
        $this->assertSame([100, 100, 50], array_map(static fn ($r) => count($r['json']->batch), $t->requests));
        $first = $t->requests[0]['json']->batch[0];
        $this->assertSame('identify', $first->type);
        $this->assertSame('u0', $first->userId);
        $this->assertSame(249, $res->received);
        $this->assertSame([['index' => 103, 'message' => 'at limit', 'code' => 'plan_limit']], $res->errors);
    }

    public function testBatchRejectsABadItemBeforeSendingAnything(): void
    {
        $t = new FakeTransport();
        $c = $this->client($t);
        $e = $this->expectError('invalid_argument', fn () => $c->batch([
            ['type' => 'identify', 'user_id' => 'u1'],
            ['type' => 'track', 'user_id' => 'u2', 'event' => ''],
        ]));
        $this->assertStringContainsString('batch[1]', $e->getMessage());
        $this->expectError('invalid_argument', fn () => $c->batch([['type' => 'nope', 'user_id' => 'u']]));
        $this->assertCount(0, $t->requests);
    }

    public function testBatchSplitsOnSizeToo(): void
    {
        $t = new FakeTransport([['body' => ['received' => 1]]]);
        $big = str_repeat('x', 120 * 1024);
        $items = [];
        foreach (['a', 'b', 'c', 'd'] as $u) {
            $items[] = ['type' => 'track', 'user_id' => $u, 'event' => 'e', 'properties' => ['p' => $big]];
        }
        $this->client($t)->batch($items);
        $this->assertGreaterThanOrEqual(2, count($t->requests));
        foreach ($t->requests as $r) {
            $this->assertLessThan(512 * 1024, strlen($r['body']));
        }
    }

    public function testTimeoutIsPassedToTheTransport(): void
    {
        $t = new FakeTransport();
        $this->client($t, ['timeout' => 2.5])->track('u1', 'e');
        $this->assertSame(2.5, $t->requests[0]['timeout']);
    }
}

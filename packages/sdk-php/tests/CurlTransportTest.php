<?php

declare(strict_types=1);

namespace Loomail\Tests;

use Loomail\Client;
use Loomail\CurlTransport;
use Loomail\LoomailException;
use Loomail\TransportException;
use PHPUnit\Framework\TestCase;

/** The real curl transport against PHP's built-in web server. */
final class CurlTransportTest extends TestCase
{
    /** @var resource|null */
    private static $proc = null;
    private static int $port = 0;

    public static function setUpBeforeClass(): void
    {
        $sock = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
        self::$port = (int) explode(':', stream_socket_get_name($sock, false))[1];
        fclose($sock);
        $cmd = [PHP_BINARY, '-S', '127.0.0.1:' . self::$port, __DIR__ . '/fixtures/server.php'];
        self::$proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        for ($i = 0; $i < 50; $i++) {
            if (@fsockopen('127.0.0.1', self::$port, $e, $s, 0.1)) {
                return;
            }
            usleep(100_000);
        }
        self::fail('the test server did not start');
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$proc) {
            proc_terminate(self::$proc);
            proc_close(self::$proc);
        }
    }

    private function client(string $prefix = '', array $extra = []): Client
    {
        return new Client($extra + ['secret_key' => 'mf_live_curl', 'host' => 'http://127.0.0.1:' . self::$port . $prefix, 'sleep' => static function (float $s): void {}]);
    }

    public function testSendsAJsonPostWithTheKeyOverRealHttp(): void
    {
        $post = (new CurlTransport())->post('http://127.0.0.1:' . self::$port . '/echo/v1/track', ['Authorization' => 'Bearer k', 'Content-Type' => 'application/json'], '{"a":1}', 5.0);
        $this->assertSame(200, $post['status']);
        $this->assertSame('application/json', $post['headers']['content-type']);
        $seen = json_decode($post['body'], true)['seen'];
        $this->assertSame('Bearer k', $seen['auth']);
        $this->assertSame('application/json', $seen['content_type']);
        $this->assertSame(['a' => 1], $seen['body']);
    }

    public function testClientEndToEnd(): void
    {
        $r = $this->client('/echo')->track('u1', 'paid', ['amount' => 1]);
        $this->assertFalse($r->deduplicated);
    }

    public function testA4xxComesBackAsAnErrorWithTheServersMessage(): void
    {
        try {
            $this->client('/limit')->track('u1', 'e');
            $this->fail('expected an exception');
        } catch (LoomailException $e) {
            $this->assertSame('plan_limit', $e->errorCode);
            $this->assertSame(402, $e->status);
            $this->assertStringContainsString('contact limit', $e->getMessage());
        }
    }

    public function testATimeoutIsANetworkError(): void
    {
        $this->expectException(TransportException::class);
        (new CurlTransport())->post('http://127.0.0.1:' . self::$port . '/slow/v1/track', [], '{}', 0.3);
    }

    public function testAClientTimeoutSurfacesAsNetwork(): void
    {
        try {
            $this->client('/slow', ['timeout' => 0.3, 'max_retries' => 0])->track('u1', 'e');
            $this->fail('expected an exception');
        } catch (LoomailException $e) {
            $this->assertSame('network', $e->errorCode);
        }
    }

    public function testADeadPortIsANetworkError(): void
    {
        $c = new Client(['secret_key' => 'mf_live_x', 'host' => 'http://127.0.0.1:1', 'max_retries' => 1, 'sleep' => static function (float $s): void {}]);
        try {
            $c->track('u1', 'e');
            $this->fail('expected an exception');
        } catch (LoomailException $e) {
            $this->assertSame('network', $e->errorCode);
        }
    }

    public function testRedirectsAreNotFollowed(): void
    {
        try {
            $this->client('/redirect')->track('u1', 'e');
            $this->fail('expected an exception');
        } catch (LoomailException $e) {
            $this->assertSame(302, $e->status); // answered, not followed to the other address
        }
    }

    public function testOnlyHttpAndHttpsAddressesAreAllowed(): void
    {
        $this->expectException(TransportException::class);
        (new CurlTransport())->post('file:///etc/passwd', [], '{}', 2.0);
    }
}

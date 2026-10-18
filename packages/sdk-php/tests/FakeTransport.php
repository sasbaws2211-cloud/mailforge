<?php

declare(strict_types=1);

namespace Loomail\Tests;

use Loomail\Transport;
use Loomail\TransportException;

/** Answers from a script and records every request. A scripted Throwable is thrown instead of answered. */
final class FakeTransport implements Transport
{
    /** @var list<array{url:string, headers:array<string,string>, body:string, json:mixed, timeout:float}> */
    public array $requests = [];
    /** @var list<array{status:int, headers:array<string,string>, body:string}|\Throwable> */
    private array $script;

    /** @param list<array{status?:int, headers?:array<string,string>, body?:mixed}|\Throwable> $script the last entry repeats */
    public function __construct(array $script = [])
    {
        $this->script = array_map(static fn ($r) => $r instanceof \Throwable ? $r : [
            'status' => $r['status'] ?? 200,
            'headers' => $r['headers'] ?? [],
            'body' => is_string($r['body'] ?? '') ? ($r['body'] ?? '') : json_encode($r['body']),
        ], $script ?: [['status' => 200, 'body' => ['success' => true]]]);
    }

    public function post(string $url, array $headers, string $body, float $timeoutSeconds): array
    {
        $this->requests[] = ['url' => $url, 'headers' => $headers, 'body' => $body, 'json' => json_decode($body, false), 'timeout' => $timeoutSeconds];
        $i = min(count($this->requests), count($this->script)) - 1;
        $next = $this->script[$i];
        if ($next instanceof \Throwable) {
            throw $next;
        }
        return $next;
    }
}

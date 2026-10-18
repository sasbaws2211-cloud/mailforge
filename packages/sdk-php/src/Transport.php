<?php

declare(strict_types=1);

namespace Loomail;

/**
 * How a request leaves the process. The default is CurlTransport; pass your own to Client for tests or a proxy.
 * Implementations return the response whatever its status, and throw TransportException when there was no answer.
 */
interface Transport
{
    /**
     * @param array<string,string> $headers
     * @return array{status:int, headers:array<string,string>, body:string} header names in lower case
     * @throws TransportException
     */
    public function post(string $url, array $headers, string $body, float $timeoutSeconds): array;
}

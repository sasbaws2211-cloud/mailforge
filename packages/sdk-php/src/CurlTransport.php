<?php

declare(strict_types=1);

namespace Loomail;

/** The default transport, on PHP's curl extension. */
final class CurlTransport implements Transport
{
    public function post(string $url, array $headers, string $body, float $timeoutSeconds): array
    {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new TransportException('curl could not be started');
        }
        $responseHeaders = [];
        $lines = [];
        foreach ($headers as $name => $value) {
            $lines[] = $name . ': ' . $value;
        }
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $lines,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_TIMEOUT_MS => (int) max(1, round($timeoutSeconds * 1000)),
            CURLOPT_CONNECTTIMEOUT_MS => (int) max(1, round(min($timeoutSeconds, 10.0) * 1000)),
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$responseHeaders): int {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ]);
        $raw = curl_exec($ch);
        if ($raw === false) {
            $error = curl_error($ch);
            curl_close($ch);
            throw new TransportException($error !== '' ? $error : 'the request failed');
        }
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        return ['status' => $status, 'headers' => $responseHeaders, 'body' => (string) $raw];
    }
}

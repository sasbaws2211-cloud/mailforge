<?php

declare(strict_types=1);

namespace Loomail;

/**
 * Server-side client for Loomail's ingestion API.
 *
 * Sends identify and track calls with a secret key (mf_live_...), retries what is safe to retry, and never
 * double-counts: every call carries a messageId, which Loomail uses to drop repeats.
 *
 *     $loomail = new \Loomail\Client(['secret_key' => getenv('LOOMAIL_SECRET_KEY')]);
 *     $loomail->identify('user_123', ['email' => 'a@b.c', 'plan' => 'trial']);
 *     $loomail->track('user_123', 'signed_up', ['source' => 'ads']);
 *
 * Methods throw LoomailException when Loomail cannot be reached or refuses the call. In a web request that means a
 * Loomail outage can fail the request, so wrap fire-and-forget calls in try/catch (or run them on a queue).
 */
final class Client
{
    public const DEFAULT_HOST = 'https://loomail.site';
    /** Loomail rejects a batch of more than 100 items or more than 512 KB. */
    public const MAX_BATCH_ITEMS = 100;
    private const MAX_BATCH_BYTES = 400 * 1024; // headroom under the server's 512 KB body limit

    private string $secretKey;
    private string $host;
    private float $timeout;
    private int $maxRetries;
    private Transport $transport;
    /** @var callable(float):void */
    private $sleep;

    /**
     * @param array{secret_key?:string, host?:string, timeout?:float|int, max_retries?:int, transport?:Transport, sleep?:callable} $options
     *        secret_key  mf_live_... (default: the LOOMAIL_SECRET_KEY environment variable). Never use it in a browser.
     *        host        your Loomail install (default: LOOMAIL_HOST, then https://loomail.site)
     *        timeout     seconds per attempt (default 10)
     *        max_retries retries after the first attempt, on network errors, 429 and 5xx (default 3)
     *        transport   replaces curl (tests, proxies)
     *        sleep       replaces the wait between retries (tests); receives seconds
     */
    public function __construct(array $options = [])
    {
        $key = $options['secret_key'] ?? (getenv('LOOMAIL_SECRET_KEY') ?: '');
        if ($key === '') {
            throw new LoomailException(LoomailException::INVALID_ARGUMENT, 'secret_key is required (or set LOOMAIL_SECRET_KEY)');
        }
        if (str_starts_with($key, 'mf_pub_')) {
            throw new LoomailException(
                LoomailException::INVALID_ARGUMENT,
                'That is a publishable key (mf_pub_...), meant for browsers. Server code needs a secret key (mf_live_...).'
            );
        }
        $this->secretKey = $key;
        $host = $options['host'] ?? (getenv('LOOMAIL_HOST') ?: self::DEFAULT_HOST);
        $this->host = rtrim($host, '/');
        $this->timeout = (float) ($options['timeout'] ?? 10);
        $this->maxRetries = max(0, (int) ($options['max_retries'] ?? 3));
        $this->transport = $options['transport'] ?? new CurlTransport();
        $this->sleep = $options['sleep'] ?? static function (float $seconds): void {
            usleep((int) round($seconds * 1_000_000));
        };
    }

    /**
     * Create or update a person. Traits merge into what Loomail already knows; a null trait removes it.
     *
     * @param array<string,mixed> $traits
     * @param array{timestamp?:\DateTimeInterface|string, message_id?:string, context?:array<string,mixed>} $options
     */
    public function identify(string $userId, array $traits = [], array $options = []): CallResult
    {
        return $this->send('/v1/identify', $this->identifyBody($userId, $traits, $options));
    }

    /**
     * Record something a person did.
     *
     * @param array<string,mixed> $properties
     * @param array{timestamp?:\DateTimeInterface|string, message_id?:string, context?:array<string,mixed>} $options
     */
    public function track(string $userId, string $event, array $properties = [], array $options = []): CallResult
    {
        return $this->send('/v1/track', $this->trackBody($userId, $event, $properties, $options));
    }

    /**
     * Send many identify/track items. Splits them into requests of at most 100 items (and under the size limit), so any
     * length is fine. A refused item lands in the result's `errors` and does not stop the rest; a request that fails
     * outright (bad key, an outage after retries) throws.
     *
     * Each item is ['type' => 'identify', 'user_id' => ..., 'traits' => [...]] or
     * ['type' => 'track', 'user_id' => ..., 'event' => ..., 'properties' => [...]], plus the optional timestamp,
     * message_id and context.
     *
     * @param list<array<string,mixed>> $items
     */
    public function batch(array $items): BatchResult
    {
        $prepared = [];
        foreach (array_values($items) as $i => $item) {
            try {
                $type = $item['type'] ?? null;
                if ($type === 'identify') {
                    $body = $this->identifyBody((string) ($item['user_id'] ?? ''), (array) ($item['traits'] ?? []), $item);
                } elseif ($type === 'track') {
                    $body = $this->trackBody((string) ($item['user_id'] ?? ''), (string) ($item['event'] ?? ''), (array) ($item['properties'] ?? []), $item);
                } else {
                    throw new LoomailException(LoomailException::INVALID_ARGUMENT, 'type must be "identify" or "track"');
                }
            } catch (LoomailException $e) {
                throw new LoomailException(LoomailException::INVALID_ARGUMENT, "batch[$i]: " . $e->getMessage());
            }
            $prepared[] = ['type' => $type] + $body;
        }

        $received = 0;
        $errors = [];
        $chunk = [];
        $chunkBytes = 0;
        $chunkStart = 0;
        $flush = function () use (&$chunk, &$chunkBytes, &$chunkStart, &$received, &$errors): void {
            if ($chunk === []) {
                return;
            }
            $res = $this->post('/v1/batch', ['batch' => $chunk]);
            $received += (int) ($res['received'] ?? 0);
            foreach ((array) ($res['errors'] ?? []) as $err) {
                $error = ['index' => (int) ($err['index'] ?? 0) + $chunkStart, 'message' => (string) ($err['message'] ?? '')];
                if (isset($err['code'])) {
                    $error['code'] = (string) $err['code'];
                }
                $errors[] = $error;
            }
            $chunkStart += count($chunk);
            $chunk = [];
            $chunkBytes = 0;
        };
        foreach ($prepared as $item) {
            $size = strlen(self::encode($item)) + 1;
            if (count($chunk) >= self::MAX_BATCH_ITEMS || ($chunk !== [] && $chunkBytes + $size > self::MAX_BATCH_BYTES)) {
                $flush();
            }
            $chunk[] = $item;
            $chunkBytes += $size;
        }
        $flush();

        return new BatchResult($received, $errors);
    }

    // ---------------------------------------------------------------------

    /** @return array<string,mixed> */
    private function base(string $userId, array $options): array
    {
        if (trim($userId) === '') {
            throw new LoomailException(LoomailException::INVALID_ARGUMENT, 'userId must be a non-empty string');
        }
        $body = ['userId' => $userId, 'messageId' => (string) ($options['message_id'] ?? self::uuid())];
        if (isset($options['timestamp'])) {
            $body['timestamp'] = self::iso($options['timestamp']);
        }
        if (isset($options['context'])) {
            $body['context'] = self::object((array) $options['context']);
        }
        return $body;
    }

    /** @return array<string,mixed> */
    private function identifyBody(string $userId, array $traits, array $options): array
    {
        return $this->base($userId, $options) + ['traits' => self::object($traits)];
    }

    /** @return array<string,mixed> */
    private function trackBody(string $userId, string $event, array $properties, array $options): array
    {
        $body = $this->base($userId, $options);
        if (trim($event) === '') {
            throw new LoomailException(LoomailException::INVALID_ARGUMENT, 'event must be a non-empty string');
        }
        return $body + ['event' => $event, 'properties' => self::object($properties)];
    }

    /** An empty PHP array encodes as [], but Loomail wants an object here. */
    private static function object(array $data): array|\stdClass
    {
        return $data === [] ? new \stdClass() : $data;
    }

    private static function iso(\DateTimeInterface|string $ts): string
    {
        try {
            $d = $ts instanceof \DateTimeInterface ? \DateTimeImmutable::createFromInterface($ts) : new \DateTimeImmutable($ts);
        } catch (\Exception) {
            throw new LoomailException(LoomailException::INVALID_ARGUMENT, 'timestamp is not a valid date: ' . $ts);
        }
        return $d->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z');
    }

    private static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        $h = bin2hex($b);
        return sprintf('%s-%s-%s-%s-%s', substr($h, 0, 8), substr($h, 8, 4), substr($h, 12, 4), substr($h, 16, 4), substr($h, 20));
    }

    private static function encode(array $body): string
    {
        try {
            return json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
        } catch (\JsonException $e) {
            throw new LoomailException(LoomailException::INVALID_ARGUMENT, 'The data could not be encoded as JSON: ' . $e->getMessage(), null, null, $e);
        }
    }

    private function send(string $path, array $body): CallResult
    {
        $res = $this->post($path, $body);
        return new CallResult(($res['deduplicated'] ?? false) === true);
    }

    private static function codeForStatus(int $status): string
    {
        return match (true) {
            $status === 401 => LoomailException::UNAUTHORIZED,
            $status === 402 => LoomailException::PLAN_LIMIT,
            $status === 403 => LoomailException::FORBIDDEN,
            $status === 429 => LoomailException::RATE_LIMITED,
            $status >= 500 => LoomailException::SERVER,
            default => LoomailException::VALIDATION,
        };
    }

    /** One POST with retries. Every body here carries a messageId, so repeating it is safe. */
    private function post(string $path, array $body): array
    {
        $payload = self::encode($body);
        $headers = [
            'Authorization' => 'Bearer ' . $this->secretKey,
            'Content-Type' => 'application/json',
            'User-Agent' => 'loomail-php/0.1.0',
        ];
        for ($attempt = 0;; $attempt++) {
            try {
                $res = $this->transport->post($this->host . $path, $headers, $payload, $this->timeout);
            } catch (TransportException $e) {
                if ($attempt >= $this->maxRetries) {
                    throw new LoomailException(
                        LoomailException::NETWORK,
                        "Could not reach Loomail at {$this->host}: " . $e->getMessage(),
                        null,
                        null,
                        $e
                    );
                }
                ($this->sleep)(min(self::backoff($attempt), 30.0));
                continue;
            }

            $status = $res['status'];
            $parsed = $res['body'] === '' ? null : json_decode($res['body'], true);
            if ($parsed === null && $res['body'] !== '' && json_last_error() !== JSON_ERROR_NONE) {
                $parsed = $res['body'];
            }
            if ($status >= 200 && $status < 300) {
                return is_array($parsed) ? $parsed : [];
            }
            $retryable = $status === 429 || $status >= 500;
            if (!$retryable || $attempt >= $this->maxRetries) {
                $detail = is_array($parsed) && is_string($parsed['error'] ?? null) ? ': ' . $parsed['error'] : '';
                throw new LoomailException(self::codeForStatus($status), "Loomail answered {$status}{$detail}", $status, $parsed);
            }
            $after = $res['headers']['retry-after'] ?? null;
            $wait = ($after !== null && is_numeric($after) && (float) $after >= 0) ? (float) $after : self::backoff($attempt);
            ($this->sleep)(min($wait, 30.0));
        }
    }

    /** 0.5s, 1s, 2s... with up to 25% jitter. */
    private static function backoff(int $attempt): float
    {
        $base = 0.5 * (2 ** $attempt);
        return $base + (mt_rand() / mt_getrandmax()) * $base * 0.25;
    }
}

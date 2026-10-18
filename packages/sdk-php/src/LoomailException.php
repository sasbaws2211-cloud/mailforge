<?php

declare(strict_types=1);

namespace Loomail;

/**
 * Thrown when Loomail cannot be reached or refuses a call. `$code` is one of the CODE_* constants (the exception's own
 * integer code stays 0), `$status` is the HTTP status when Loomail answered, `$body` the parsed response body.
 */
final class LoomailException extends \RuntimeException
{
    public const INVALID_ARGUMENT = 'invalid_argument'; // caught before any request was made
    public const UNAUTHORIZED = 'unauthorized';         // 401: key missing, wrong or revoked
    public const FORBIDDEN = 'forbidden';               // 403: key not allowed here
    public const PLAN_LIMIT = 'plan_limit';             // 402: workspace is at its contact limit
    public const VALIDATION = 'validation';             // 400 / 422: Loomail did not accept the payload
    public const RATE_LIMITED = 'rate_limited';         // 429, still failing after retries
    public const SERVER = 'server';                     // 5xx, still failing after retries
    public const NETWORK = 'network';                   // could not reach Loomail, or it did not answer in time

    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly ?int $status = null,
        public readonly mixed $body = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }
}

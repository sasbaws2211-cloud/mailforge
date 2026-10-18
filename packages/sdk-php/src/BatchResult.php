<?php

declare(strict_types=1);

namespace Loomail;

/** What batch() returns. */
final class BatchResult
{
    /**
     * @param int $received Items Loomail accepted (a repeat of a messageId counts as accepted).
     * @param list<array{index:int, message:string, code?:string}> $errors Items it refused; `index` is the position in the
     *        array you passed, `code` is "plan_limit" when the workspace is at its contact limit.
     */
    public function __construct(
        public readonly int $received,
        public readonly array $errors,
    ) {
    }
}

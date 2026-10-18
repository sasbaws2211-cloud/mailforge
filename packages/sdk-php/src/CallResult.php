<?php

declare(strict_types=1);

namespace Loomail;

/** What identify() and track() return. */
final class CallResult
{
    public function __construct(
        /** True when Loomail had already seen this messageId and ignored the repeat. */
        public readonly bool $deduplicated,
    ) {
    }
}

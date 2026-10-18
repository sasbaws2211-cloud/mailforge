<?php

declare(strict_types=1);

namespace Loomail\Laravel\Facades;

use Illuminate\Support\Facades\Facade;
use Loomail\Client;

/**
 * @method static \Loomail\CallResult identify(string $userId, array $traits = [], array $options = [])
 * @method static \Loomail\CallResult track(string $userId, string $event, array $properties = [], array $options = [])
 * @method static \Loomail\BatchResult batch(array $items)
 *
 * @see \Loomail\Client
 */
final class Loomail extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return Client::class;
    }
}

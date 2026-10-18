<?php

declare(strict_types=1);

namespace Loomail\Laravel;

use Illuminate\Support\ServiceProvider;
use Loomail\Client;

/**
 * Laravel integration. Auto-discovered; set LOOMAIL_SECRET_KEY (and LOOMAIL_HOST for a self-hosted install) in .env.
 *
 *     use Loomail\Laravel\Facades\Loomail;
 *     Loomail::identify($user->id, ['email' => $user->email]);
 *     Loomail::track($user->id, 'signed_up');
 *
 * or type-hint \Loomail\Client in a constructor and let the container supply it. Publish the config with
 * `php artisan vendor:publish --tag=loomail-config`.
 */
final class LoomailServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../../config/loomail.php', 'loomail');

        $this->app->singleton(Client::class, static function ($app): Client {
            $config = $app['config']->get('loomail', []);
            $options = array_filter([
                'secret_key' => $config['secret_key'] ?? null,
                'host' => $config['host'] ?? null,
                'timeout' => $config['timeout'] ?? null,
                'max_retries' => $config['max_retries'] ?? null,
            ], static fn ($v) => $v !== null && $v !== '');

            return new Client($options);
        });
        $this->app->alias(Client::class, 'loomail');
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->publishes([__DIR__ . '/../../config/loomail.php' => $this->app->configPath('loomail.php')], 'loomail-config');
        }
    }
}

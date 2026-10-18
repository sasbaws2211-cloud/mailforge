<?php

declare(strict_types=1);

namespace Loomail\Tests;

use Illuminate\Config\Repository;
use Illuminate\Foundation\Application;
use Illuminate\Support\Facades\Facade;
use Loomail\Client;
use Loomail\Laravel\Facades\Loomail;
use Loomail\Laravel\LoomailServiceProvider;
use PHPUnit\Framework\TestCase;

final class LaravelTest extends TestCase
{
    private function app(array $config): Application
    {
        $app = new Application(sys_get_temp_dir());
        $app->instance('config', new Repository(['loomail' => $config]));
        $app->register(LoomailServiceProvider::class);
        return $app;
    }

    protected function tearDown(): void
    {
        Facade::clearResolvedInstances();
        Facade::setFacadeApplication(null);
    }

    public function testTheProviderBuildsTheClientFromConfigAndAliasesIt(): void
    {
        $app = $this->app(['secret_key' => 'mf_live_cfg', 'host' => 'https://loomail.example.com', 'timeout' => 3, 'max_retries' => 1]);
        $client = $app->make(Client::class);
        $this->assertInstanceOf(Client::class, $client);
        $this->assertSame($client, $app->make(Client::class), 'one shared client');
        $this->assertSame($client, $app->make('loomail'));
    }

    public function testTheDefaultConfigIsMergedSoOnlyTheKeyIsRequired(): void
    {
        $app = $this->app(['secret_key' => 'mf_live_cfg']);
        $this->assertSame(10, $app['config']->get('loomail.timeout'));
        $this->assertSame(3, $app['config']->get('loomail.max_retries'));
        $this->assertInstanceOf(Client::class, $app->make(Client::class));
    }

    public function testAMissingKeyFailsClearlyWhenTheClientIsFirstUsed(): void
    {
        putenv('LOOMAIL_SECRET_KEY');
        $app = $this->app(['secret_key' => null]);
        $this->expectExceptionMessage('secret_key is required');
        $app->make(Client::class);
    }

    public function testTheFacadeCallsTheClient(): void
    {
        $app = $this->app(['secret_key' => 'mf_live_cfg']);
        $fake = new FakeTransport();
        $app->instance(Client::class, new Client(['secret_key' => 'mf_live_cfg', 'host' => 'https://loomail.test', 'transport' => $fake]));
        Facade::setFacadeApplication($app);

        Loomail::identify('user_1', ['email' => 'a@b.c']);
        Loomail::track('user_1', 'signed_up', ['source' => 'ads']);

        $this->assertSame(['https://loomail.test/v1/identify', 'https://loomail.test/v1/track'], array_column($fake->requests, 'url'));
        $this->assertSame('signed_up', $fake->requests[1]['json']->event);
    }

    public function testPackageDiscoveryMetadataIsInComposerJson(): void
    {
        $composer = json_decode((string) file_get_contents(__DIR__ . '/../composer.json'), true);
        $this->assertSame([LoomailServiceProvider::class], $composer['extra']['laravel']['providers']);
        $this->assertSame(Loomail::class, $composer['extra']['laravel']['aliases']['Loomail']);
    }
}

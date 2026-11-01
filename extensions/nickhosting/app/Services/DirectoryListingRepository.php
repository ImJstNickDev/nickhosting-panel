<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use GuzzleHttp\Promise\Create;
use GuzzleHttp\Psr7\StreamDecoratorTrait;
use GuzzleHttp\Psr7\Utils;
use Psr\Http\Message\StreamInterface;
use Psr\Http\Message\ResponseInterface;
use Pterodactyl\Repositories\Wings\DaemonRepository;
use Pterodactyl\Transformers\Api\Client\FileObjectTransformer;

class DirectoryListingRepository extends DaemonRepository
{
    public const DIRECTORY_BYTES = 4 * 1024 * 1024;
    public const BATCH_BYTES = 8 * 1024 * 1024;
    public const DIRECTORY_ENTRIES = 10000;

    protected function now(): float { return hrtime(true) / 1e9; }

    public function listDirectories(array $directories, array $settings): array
    {
        $deadline = $this->now() + $settings['directoryTimeoutSeconds'];
        $client = $this->getHttpClient(); // Native node authentication stays inside Panel.
        $transformer = new FileObjectTransformer();
        $results = array_map(fn ($directory) => ['directory' => $directory, 'error' => 'deadline_exceeded'], $directories);
        $jsonFlags = JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_AMP | JSON_HEX_QUOT | JSON_THROW_ON_ERROR;
        $outputBytes = strlen(json_encode(['results' => $results], $jsonFlags));
        $inputBytes = 0;
        $halt = null;
        $requests = function () use ($directories, $client, $deadline, $transformer, $jsonFlags, &$results, &$inputBytes, &$outputBytes, &$halt) {
            foreach ($directories as $index => $directory) {
                yield function () use ($index, $directory, $client, $deadline, $transformer, $jsonFlags, &$results, &$inputBytes, &$outputBytes, &$halt) {
                    $remaining = $deadline - $this->now();
                    if ($halt !== null || $remaining <= 0) {
                        $results[$index]['error'] = $halt ?? 'deadline_exceeded';
                        return Create::promiseFor(null);
                    }
                    $failure = null;
                    $directoryBytes = 0;
                    // Enforce limits during streaming, including chunked/misdeclared bodies.
                    // Returning zero aborts cURL without throwing through its event loop.
                    $consume = function (int $bytes) use ($deadline, &$failure, &$directoryBytes, &$inputBytes, &$halt): bool {
                        if ($this->now() >= $deadline) { $failure = 'deadline_exceeded'; return false; }
                        if ($inputBytes + $bytes > self::BATCH_BYTES) { $halt = $failure = 'too_large'; return false; }
                        if ($directoryBytes + $bytes > self::DIRECTORY_BYTES) { $failure = 'too_large'; return false; }
                        $directoryBytes += $bytes;
                        $inputBytes += $bytes;
                        return true;
                    };
                    $sink = new class($consume) implements StreamInterface {
                        use StreamDecoratorTrait;
                        private StreamInterface $stream;
                        public function __construct(private \Closure $consume) { $this->stream = Utils::streamFor(''); }
                        public function write($string): int { return ($this->consume)(strlen($string)) ? $this->stream->write($string) : 0; }
                    };
                    $error = function ($reason) use ($index, $deadline, &$results, &$failure, $sink) {
                        $sink->close();
                        $context = method_exists($reason, 'getHandlerContext') ? $reason->getHandlerContext() : [];
                        $results[$index]['error'] = $failure ?? (($this->now() >= $deadline || ($context['errno'] ?? 0) === 28)
                            ? 'deadline_exceeded' : 'unavailable');
                        return null;
                    };
                    try {
                        return $client->getAsync(sprintf('/api/servers/%s/files/list-directory', $this->server->uuid), [
                            'query' => ['directory' => $directory === '' ? '/' : '/' . $directory],
                            'timeout' => $remaining, 'connect_timeout' => min(2, $remaining),
                            'allow_redirects' => false, 'http_errors' => false, 'sink' => $sink,
                            'on_headers' => function (ResponseInterface $response) use (&$failure, &$halt) {
                                $status = $response->getStatusCode();
                                if ($status !== 200) {
                                    $failure = match ($status) { 404 => 'not_found', 401, 403 => 'forbidden', default => 'unavailable' };
                                    if ($status === 429) { $halt = 'unavailable'; }
                                } elseif ((float) $response->getHeaderLine('Content-Length') > self::DIRECTORY_BYTES) {
                                    $failure = 'too_large';
                                }
                                if ($failure !== null) { throw new \RuntimeException('Directory response rejected'); }
                            },
                        ])->then(function (ResponseInterface $response) use ($index, $directory, $deadline, $transformer, $jsonFlags, &$results, &$outputBytes, &$halt, &$failure, $sink) {
                            try {
                                if ($failure !== null || $this->now() >= $deadline) {
                                    $results[$index]['error'] = $failure ?? 'deadline_exceeded';
                                    return null;
                                }
                                $items = json_decode((string) $sink, true, 32, JSON_THROW_ON_ERROR);
                                if (!is_array($items) || !array_is_list($items)) { throw new \UnexpectedValueException(); }
                                if (count($items) > self::DIRECTORY_ENTRIES) { $results[$index]['error'] = 'too_large'; return null; }
                                $files = array_map(fn ($item) => $transformer->transform($item), $items);
                                $result = ['directory' => $directory, 'files' => $files];
                                $delta = strlen(json_encode($result, $jsonFlags)) - strlen(json_encode($results[$index], $jsonFlags));
                                if ($outputBytes + $delta > self::BATCH_BYTES) {
                                    $halt = $results[$index]['error'] = 'too_large';
                                } elseif ($this->now() >= $deadline) {
                                    $results[$index]['error'] = 'deadline_exceeded';
                                } else {
                                    $outputBytes += $delta;
                                    $results[$index] = $result;
                                }
                            } catch (\Throwable $error) {
                                $results[$index]['error'] = 'unavailable';
                            } finally { $sink->close(); }
                            return null;
                        }, $error);
                    } catch (\Throwable $reason) { return Create::promiseFor($error($reason)); }
                };
            }
        };
        // Wait on native request promises directly: Pool/EachPromise can leave its
        // aggregate unresolved when the installed cURL handler completes a batch.
        $wait = function (array $pending) use ($deadline, &$results): void {
            foreach ($pending as $index => $promise) {
                try { $promise->wait(); }
                catch (\Throwable $error) {
                    // Still join every admitted request before starting another batch.
                    $results[$index] = ['directory' => $results[$index]['directory'],
                        'error' => $this->now() >= $deadline ? 'deadline_exceeded' : 'unavailable'];
                }
            }
        };
        $pending = [];
        foreach ($requests() as $index => $request) {
            $pending[$index] = $request();
            if (count($pending) === $settings['directoryConcurrency']) {
                $wait($pending);
                $pending = [];
            }
        }
        $wait($pending);
        return $results;
    }
}

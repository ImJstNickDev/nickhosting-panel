<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use GuzzleHttp\ClientInterface;
use GuzzleHttp\Pool;
use GuzzleHttp\Promise\Create;
use GuzzleHttp\Promise\PromiseInterface;
use GuzzleHttp\Promise\Utils as Promises;
use GuzzleHttp\Psr7\StreamDecoratorTrait;
use GuzzleHttp\Psr7\Utils;
use Psr\Http\Message\StreamInterface;
use Psr\Http\Message\ResponseInterface;
use Pterodactyl\Repositories\Wings\DaemonRepository;

/** Native node transport only. No game rules, node credentials or URLs leave Panel. */
class FileOperationRepository extends DaemonRepository
{
    public const GUARD_BYTES = 1048576;
    public const DIRECTORY_BYTES = 4194304;

    protected function now(): float { return hrtime(true) / 1e9; }

    private function sink(int $limit, ?float $deadline = null): StreamInterface
    {
        return new class($limit, fn () => $deadline !== null && $this->now() >= $deadline) implements StreamInterface {
            use StreamDecoratorTrait;
            private StreamInterface $stream;
            public bool $exceeded = false;
            private int $bytes = 0;
            public function __construct(private int $limit, private \Closure $expired) { $this->stream = Utils::streamFor(''); }
            public function write($string): int {
                if (($this->expired)()) { return 0; }
                $this->bytes += strlen($string);
                if ($this->bytes > $this->limit) { $this->exceeded = true; return 0; }
                return $this->stream->write($string);
            }
        };
    }

    private function read(ClientInterface $client, string $endpoint, array $query, int $limit, ?float $deadline = null): PromiseInterface
    {
        $remaining = $deadline === null ? 8 : min(8, $deadline - $this->now());
        abort_if($remaining <= 0, 504);
        $sink = $this->sink($limit, $deadline);
        try {
            return $client->requestAsync('GET', sprintf('/api/servers/%s/files/%s', $this->server->uuid, $endpoint), [
                'query' => $query, 'timeout' => $remaining, 'connect_timeout' => min(2, $remaining),
                'allow_redirects' => false, 'http_errors' => false, 'sink' => $sink,
                'on_headers' => function (ResponseInterface $response) use ($limit, $sink, $deadline) {
                    abort_if($deadline !== null && $this->now() >= $deadline, 504);
                    if ((float) $response->getHeaderLine('Content-Length') > $limit) {
                        $sink->exceeded = true;
                        throw new \RuntimeException('Bounded response exceeded');
                    }
                },
            ])->then(function (ResponseInterface $response) use ($sink, $limit, $deadline): string {
                try {
                    abort_if($deadline !== null && $this->now() >= $deadline, 504);
                    $status = $response->getStatusCode();
                    abort_unless($status === 200, match ($status) { 404 => 404, 401, 403 => 403, default => 502 });
                    // Mock transports and handler stacks may return an independent body.
                    $body = (string) $response->getBody();
                    abort_if($sink->exceeded || strlen($body) > $limit, 413);
                    return $body;
                } finally { $sink->close(); }
            }, function ($error) use ($sink, $deadline) {
                $exceeded = $sink->exceeded;
                $sink->close();
                abort($exceeded ? 413 : ($deadline !== null && $this->now() >= $deadline ? 504 : 502));
            });
        } catch (\Throwable $error) { $sink->close(); throw $error; }
    }

    public function inspect(string $target, string $guard): array
    {
        $client = $this->getHttpClient();
        $parent = dirname($target);
        $guardParent = dirname($guard);
        $reads = [
            $this->read($client, 'list-directory', ['directory' => $parent === '.' ? '/' : '/' . $parent], self::DIRECTORY_BYTES),
            $this->read($client, 'contents', ['file' => '/' . $guard], self::GUARD_BYTES),
        ];
        if ($guardParent !== $parent) {
            $reads[] = $this->read($client, 'list-directory', ['directory' => $guardParent === '.' ? '/' : '/' . $guardParent], self::DIRECTORY_BYTES);
        }
        $results = Promises::settle($reads)->wait();
        foreach ($results as $result) {
            if ($result['state'] !== 'fulfilled') { throw $result['reason']; }
        }
        $entries = $this->parseEntries($results[0]['value']);
        $guardEntries = $guardParent === $parent ? $entries : $this->parseEntries($results[2]['value']);
        $select = static function (array $items, string $name): array {
            $matches = array_values(array_filter($items, fn ($item) => isset($item['name']) && strcasecmp($item['name'], $name) === 0));
            abort_unless(count($matches) > 0, 404);
            abort_unless(count($matches) === 1 && $matches[0]['name'] === $name, 409);
            return $matches[0];
        };
        $entry = $select($entries, basename($target));
        $guardEntry = $select($guardEntries, basename($guard));
        abort_unless(($entry['file'] ?? null) === false && ($entry['symlink'] ?? null) === false, 409);
        abort_unless(($guardEntry['file'] ?? null) === true && ($guardEntry['symlink'] ?? null) === false, 409);
        abort_unless(($guardEntry['size'] ?? null) === strlen($results[1]['value']), 409);
        // This is a metadata observation, not an inode identity or filesystem CAS.
        $metadata = [];
        foreach (['name', 'mode', 'mode_bits', 'size', 'file', 'symlink', 'created', 'modified'] as $field) {
            abort_unless(array_key_exists($field, $entry), 502);
            $metadata[$field] = $entry[$field];
        }
        $contents = $results[1]['value'];
        abort_unless(preg_match('//u', $contents) === 1, 422);
        return ['target' => ['path' => $target, 'observation' => hash('sha256', json_encode($metadata, JSON_THROW_ON_ERROR))],
            'guard' => ['path' => $guard, 'sha256' => hash('sha256', $contents), 'contents' => $contents]];
    }

    private function parseEntries(string $body): array
    {
        try { $entries = json_decode($body, true, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException $error) { abort(502); }
        abort_unless(is_array($entries) && array_is_list($entries), 502);
        abort_if(count($entries) > 10000, 413);
        return $entries;
    }

    private function entries(ClientInterface $client, string $directory): array
    {
        return $this->parseEntries($this->read($client, 'list-directory', ['directory' => '/' . $directory], self::DIRECTORY_BYTES)->wait());
    }

    private function entriesPair(ClientInterface $client, string $first, string $second): array
    {
        $results = Promises::settle(array_map(fn ($directory) => $this->read($client, 'list-directory',
            ['directory' => '/' . $directory], self::DIRECTORY_BYTES), [$first, $second]))->wait();
        foreach ($results as $result) { if ($result['state'] !== 'fulfilled') { throw $result['reason']; } }
        return array_map(fn ($result) => $this->parseEntries($result['value']), $results);
    }

    private function mutate(ClientInterface $client, string $method, string $endpoint, array $body): void
    {
        // Use the same asynchronous handler/connection pool as the reads. Native
        // request(stream=true) otherwise bypasses cURL and cannot reuse its socket.
        $sink = $this->sink(0);
        try {
            $response = $client->requestAsync($method, sprintf('/api/servers/%s/files/%s', $this->server->uuid, $endpoint), [
                'json' => $body, 'timeout' => 30, 'connect_timeout' => 2,
                'allow_redirects' => false, 'http_errors' => false, 'sink' => $sink,
                'on_headers' => static function (ResponseInterface $response) {
                    if ($response->getStatusCode() !== 204) { throw new \RuntimeException('Filesystem operation not confirmed'); }
                },
            ])->wait();
            try {
                if ($response->getStatusCode() !== 204 || $sink->exceeded || (string) $response->getBody() !== '') {
                    throw new \RuntimeException('Filesystem operation not confirmed');
                }
            } finally { $response->getBody()->close(); }
        } finally { $sink->close(); }
    }

    private function verifyTree(ClientInterface $client, string $scratch, array $expected): void
    {
        $deadline = $this->now() + 30;
        $concurrency = app(Settings::class)->operational(['directoryConcurrency'])['directoryConcurrency'];
        $failure = null;
        $requests = function () use ($client, $scratch, $expected, $deadline, &$failure) {
            foreach ($expected as $directory => $wanted) {
                yield function () use ($client, $scratch, $directory, $wanted, $deadline, &$failure) {
                    // Pool refills a free slot immediately. An error halts queued
                    // reads, but already dispatched requests must settle before return.
                    if ($failure !== null) { return Create::promiseFor(null); }
                    try {
                        return $this->read($client, 'list-directory',
                            ['directory' => '/' . $scratch . ($directory === '' ? '' : '/' . $directory)],
                            self::DIRECTORY_BYTES, $deadline)->then(function (string $body) use ($wanted, $deadline) {
                                $entries = $this->parseEntries($body);
                                abort_unless(count($entries) === count($wanted), 409);
                                foreach ($entries as $entry) {
                                    $item = $wanted[$entry['name']] ?? null;
                                    abort_unless($item !== null && ($entry['symlink'] ?? true) === false && $entry['file'] === $item['file']
                                        && (!$item['file'] || $entry['size'] === $item['size']), 409);
                                    unset($wanted[$entry['name']]);
                                }
                                abort_unless($wanted === [], 409);
                                abort_if($this->now() >= $deadline, 504);
                            });
                    } catch (\Throwable $error) { return Create::rejectionFor($error); }
                };
            }
        };
        (new Pool($client, $requests(), [
            'concurrency' => $concurrency,
            'rejected' => static function ($error) use (&$failure) { $failure ??= $error; },
        ]))->promise()->wait();
        if ($failure !== null) { throw $failure; }
    }

    /** Optional request-local timings; no logs or persistent profiling state. */
    private function stage(string $name, callable $perform, ?callable $onStage): mixed
    {
        if ($onStage === null) { return $perform(); }
        $started = $this->now();
        try { return $perform(); }
        finally { $onStage($name, ($this->now() - $started) * 1000); }
    }

    public function commitArchive(string $operationId, string $destination, array $files, ?callable $beforeDispatch = null, ?callable $onStage = null): void
    {
        // DaemonRepository creates a new client on each call. Keep this one local
        // to the operation, including cleanup; never retain it across setServer().
        $client = $this->getHttpClient();
        $scratch = '.nickhosting-import-' . $operationId;
        // The source archive is produced by Core's validated streaming ZIP encoder.
        // The digest binds the durable request; it does not cause another archive download.
        $expected = $this->stage('preflight', function () use ($client, $scratch, $destination, $files) {
            [$root, $scratchEntries] = $this->entriesPair($client, '', $scratch);
            foreach ($root as $entry) {
                abort_if(strcasecmp($entry['name'], $destination) === 0, 409);
                if ($entry['name'] === $scratch) {
                    abort_unless(($entry['file'] ?? null) === false && ($entry['symlink'] ?? null) === false, 409);
                }
            }
            abort_unless(count($scratchEntries) === 1 && $scratchEntries[0]['name'] === 'payload.zip'
                && ($scratchEntries[0]['file'] ?? null) === true && ($scratchEntries[0]['symlink'] ?? null) === false, 409);
            $expected = ['' => ['payload.zip' => ['file' => true, 'size' => $scratchEntries[0]['size']], $destination => ['file' => false]]];
            foreach ($files as $file) {
                $parts = explode('/', $file['path']);
                $name = array_pop($parts); $parent = implode('/', $parts);
                if (isset($expected[$parent][$name])) { abort(422); }
                $expected[$parent][$name] = ['file' => true, 'size' => $file['size']];
                while (count($parts) > 1) {
                    $name = array_pop($parts); $parent = implode('/', $parts);
                    if (isset($expected[$parent][$name]) && $expected[$parent][$name]['file']) { abort(422); }
                    $expected[$parent][$name] = ['file' => false];
                }
            }
            return $expected;
        }, $onStage);
        if ($beforeDispatch !== null) { $beforeDispatch(); }
        $this->stage('decompress', fn () => $this->mutate($client, 'POST', 'decompress', ['root' => '/' . $scratch, 'file' => 'payload.zip']), $onStage);
        // Account for every extracted entry, including denied/ignored paths and empty artifacts.
        // A rolling window avoids waiting for the slowest member of each pair.
        $this->stage('verify_tree', fn () => $this->verifyTree($client, $scratch, $expected), $onStage);
        // A fresh target check belongs immediately before publish, not before decompression.
        $this->stage('destination_check', function () use ($client, $destination) {
            foreach ($this->entries($client, '') as $entry) { abort_if(strcasecmp($entry['name'], $destination) === 0, 409); }
        }, $onStage);
        $this->stage('rename', fn () => $this->mutate($client, 'PUT', 'rename', ['root' => '/', 'files' => [['from' => $scratch . '/' . $destination, 'to' => $destination]]]), $onStage);
        $this->stage('readback', function () use ($client, $scratch, $destination) {
            [$publishedRoot, $remaining] = $this->entriesPair($client, '', $scratch);
            $published = false;
            foreach ($publishedRoot as $entry) {
                if ($entry['name'] === $destination) { $published = $entry['file'] === false && $entry['symlink'] === false; }
            }
            abort_unless($published, 409);
            // Wings rename can return 204 for a missing source. Check both sides before cleanup.
            abort_unless(count($remaining) === 1 && $remaining[0]['name'] === 'payload.zip'
                && $remaining[0]['file'] === true && $remaining[0]['symlink'] === false, 409);
        }, $onStage);
        $this->stage('cleanup', fn () => $this->mutate($client, 'POST', 'delete', ['root' => '/', 'files' => [$scratch]]), $onStage);
    }

    public function deleteDirectory(string $path): void
    {
        $this->mutate($this->getHttpClient(), 'POST', 'delete', ['root' => '/', 'files' => [$path]]);
    }

    /** Wings refuses rename-overwrite. Preserve the original until the staged
     * file's publication is observed; never recover an uncertain write by retry. */
    public function publishUpload(string $operationId, string $source, string $destination, callable $beforeDispatch, callable $confirmed): void
    {
        $client = $this->getHttpClient();
        $parent = dirname($source);
        $directory = $parent === '.' ? '' : $parent;
        $backup = ($directory === '' ? '' : $directory . '/') . '.nh-upload-' . $operationId . '.previous';
        $find = static function (array $entries, string $name): ?array {
            $matches = array_values(array_filter($entries, fn ($entry) => isset($entry['name']) && strcasecmp($entry['name'], $name) === 0));
            abort_if(count($matches) > 1 || (count($matches) === 1 && $matches[0]['name'] !== $name), 409);
            return $matches[0] ?? null;
        };
        $metadata = static function (?array $entry): array {
            abort_unless($entry !== null && ($entry['file'] ?? null) === true && ($entry['symlink'] ?? null) === false
                && is_string($entry['mode'] ?? null) && str_starts_with($entry['mode'], '-')
                && is_string($entry['mode_bits'] ?? null) && preg_match('/^[0-7]{1,4}$/D', $entry['mode_bits'])
                && is_int($entry['size'] ?? null) && $entry['size'] >= 0 && is_string($entry['modified'] ?? null), 409);
            // Rename changes ctime, not mtime. This is an observation, not inode/CAS proof.
            return ['mode' => octdec($entry['mode_bits']), 'size' => $entry['size'], 'modified' => $entry['modified']];
        };
        $entries = $this->entries($client, $directory);
        $staged = $metadata($find($entries, basename($source)));
        $original = $metadata($find($entries, basename($destination)));
        abort_unless($staged['mode'] === $original['mode'] && $find($entries, basename($backup)) === null, 409);
        $rename = fn ($from, $to) => $this->mutate($client, 'PUT', 'rename', ['root' => '/', 'files' => [['from' => $from, 'to' => $to]]]);
        $beforeDispatch(['stagedMetadata' => $staged, 'originalMetadata' => $original]);
        $rename($destination, $backup);
        $rename($source, $destination);
        // Native rename also returns 204 when a source is absent. Observe both
        // sides before deleting any old bytes; ambiguous outcomes preserve all.
        $entries = $this->entries($client, $directory);
        abort_unless($find($entries, basename($source)) === null
            && $metadata($find($entries, basename($destination))) === $staged
            && $metadata($find($entries, basename($backup))) === $original, 409);
        $confirmed();
        try { $this->mutate($client, 'POST', 'delete', ['root' => '/', 'files' => [$backup]]); }
        catch (\Throwable $error) { /* Confirmed publication; retain recoverable old bytes. */ }
    }
}

<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use GuzzleHttp\ClientInterface;
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
        return [$this->entries($client, $first), $this->entries($client, $second)];
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
        // Only uncertain receipt recovery needs this tree observation. Sequential
        // reads avoid the installed Guzzle pool's incomplete promise settlement.
        foreach ($expected as $directory => $wanted) {
            $entries = $this->parseEntries($this->read($client, 'list-directory',
                ['directory' => '/' . implode('/', array_filter([$scratch, $directory], fn ($part) => $part !== ''))],
                self::DIRECTORY_BYTES, $deadline)->wait());
            abort_unless(count($entries) === count($wanted), 409);
            foreach ($entries as $entry) {
                $item = $wanted[$entry['name']] ?? null;
                abort_unless($item !== null && ($entry['symlink'] ?? true) === false && $entry['file'] === $item['file']
                    && (!$item['file'] || $entry['size'] === $item['size']), 409);
                unset($wanted[$entry['name']]);
            }
            abort_unless($wanted === [], 409);
            abort_if($this->now() >= $deadline, 504);
        }
    }

    /** Optional request-local timings; no logs or persistent profiling state. */
    private function stage(string $name, callable $perform, ?callable $onStage): mixed
    {
        if ($onStage === null) { return $perform(); }
        $started = $this->now();
        try { return $perform(); }
        finally { $onStage($name, ($this->now() - $started) * 1000); }
    }

    private function archiveEntry(array $entries, string $name): ?array
    {
        $matches = array_values(array_filter($entries, fn ($entry) => isset($entry['name']) && strcasecmp($entry['name'], $name) === 0));
        abort_if(count($matches) > 1 || (count($matches) === 1 && $matches[0]['name'] !== $name), 409);
        return $matches[0] ?? null;
    }

    private function archivePayload(array $entries): array
    {
        $payload = $this->archiveEntry($entries, 'payload.zip');
        abort_unless($payload !== null && ($payload['file'] ?? null) === true && ($payload['symlink'] ?? null) === false
            && is_int($payload['size'] ?? null) && $payload['size'] >= 0
            && is_string($payload['modified'] ?? null) && $payload['modified'] !== '', 409);
        return ['size' => $payload['size'], 'modified' => $payload['modified']];
    }

    private function archiveTree(array $files): array
    {
        $expected = [];
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
    }

    private function publishArchiveTree(ClientInterface $client, string $scratch, string $destination, array $payload, ?callable $beforeWrite, ?callable $onStage): void
    {
        // A fresh target check belongs immediately before publish, not before decompression.
        $this->stage('destination_check', function () use ($client, $destination) {
            abort_unless($this->archiveEntry($this->entries($client, ''), $destination) === null, 409);
        }, $onStage);
        if ($beforeWrite !== null) { $beforeWrite('publishing', $payload); }
        $this->stage('rename', fn () => $this->mutate($client, 'PUT', 'rename', ['root' => '/', 'files' => [['from' => $scratch . '/' . $destination, 'to' => $destination]]]), $onStage);
        $this->stage('readback', function () use ($client, $scratch, $destination, $payload) {
            [$publishedRoot, $remaining] = $this->entriesPair($client, '', $scratch);
            $published = $this->archiveEntry($publishedRoot, $destination);
            abort_unless($published !== null && ($published['file'] ?? null) === false && ($published['symlink'] ?? null) === false, 409);
            // Wings rename can return 204 for a missing source. Check both sides before cleanup.
            abort_unless(count($remaining) === 1 && $this->archivePayload($remaining) === $payload, 409);
        }, $onStage);
        if ($beforeWrite !== null) { $beforeWrite('cleaning', $payload); }
        $this->stage('cleanup', fn () => $this->mutate($client, 'POST', 'delete', ['root' => '/', 'files' => [$scratch]]), $onStage);
    }

    public function commitArchive(string $operationId, string $destination, array $files, ?callable $beforeDispatch = null, ?callable $onStage = null): void
    {
        // DaemonRepository creates a new client on each call. Keep this one local
        // to the operation, including cleanup; never retain it across setServer().
        $client = $this->getHttpClient();
        $scratch = '.nickhosting-import-' . $operationId;
        // The source archive is produced by Core's validated streaming ZIP encoder.
        // The digest binds the durable request; it does not cause another archive download.
        $payload = $this->stage('preflight', function () use ($client, $scratch, $destination, $files) {
            [$root, $scratchEntries] = $this->entriesPair($client, '', $scratch);
            foreach ($root as $entry) {
                abort_if(strcasecmp($entry['name'], $destination) === 0, 409);
                if ($entry['name'] === $scratch) {
                    abort_unless(($entry['file'] ?? null) === false && ($entry['symlink'] ?? null) === false, 409);
                }
            }
            abort_unless(count($scratchEntries) === 1 && $scratchEntries[0]['name'] === 'payload.zip'
                && ($scratchEntries[0]['file'] ?? null) === true && ($scratchEntries[0]['symlink'] ?? null) === false, 409);
            $this->archiveTree($files); // Retain manifest path/collision admission before dispatch.
            return $this->archivePayload($scratchEntries);
        }, $onStage);
        if ($beforeDispatch !== null) { $beforeDispatch('extracting', $payload); }
        $this->stage('decompress', fn () => $this->mutate($client, 'POST', 'decompress', ['root' => '/' . $scratch, 'file' => 'payload.zip']), $onStage);
        // Wings acknowledges decompression synchronously. Core already validated
        // this exact archive: only an uncertain receipt needs a full tree scan.
        $this->publishArchiveTree($client, $scratch, $destination, $payload, $beforeDispatch, $onStage);
    }

    /** The controller holds the original receipt's lock and verifies its fingerprint.
     * Observe the complete retained tree; never replay upload or decompression. */
    public function recoverArchive(string $operationId, string $destination, array $files, ?array $recovery, callable $beforeWrite, ?callable $onStage = null): void
    {
        if ($recovery !== null) {
            abort_unless(($recovery['schemaVersion'] ?? null) === 1 && ($recovery['kind'] ?? null) === 'archive'
                && in_array($recovery['phase'] ?? null, ['extracting', 'publishing', 'cleaning'], true)
                && is_int($recovery['payload']['size'] ?? null) && $recovery['payload']['size'] >= 0
                && is_string($recovery['payload']['modified'] ?? null) && $recovery['payload']['modified'] !== '', 409);
        }
        $client = $this->getHttpClient();
        $scratch = '.nickhosting-import-' . $operationId;
        $root = $this->stage('preflight', fn () => $this->entries($client, ''), $onStage);
        $source = $this->archiveEntry($root, $scratch);
        $published = $this->archiveEntry($root, $destination);
        foreach ([$source, $published] as $entry) {
            if ($entry !== null) { abort_unless(($entry['file'] ?? null) === false && ($entry['symlink'] ?? null) === false, 409); }
        }
        $remaining = $source === null ? [] : $this->entries($client, $scratch);
        $payload = $source === null ? null : $this->archivePayload($remaining);
        if ($payload !== null && $recovery !== null) { abort_unless($payload === $recovery['payload'], 409); }
        if ($published !== null) {
            // An old receipt with no rename marker cannot prove ownership of an
            // already-existing destination, even when its file sizes happen to match.
            abort_unless($recovery !== null && in_array($recovery['phase'], ['publishing', 'cleaning'], true)
                && ($source === null || count($remaining) === 1), 409);
            $this->stage('verify_tree', fn () => $this->verifyTree($client, '', $this->archiveTree($files)), $onStage);
            if ($source !== null) {
                $beforeWrite('cleaning', $payload);
                $this->stage('cleanup', fn () => $this->mutate($client, 'POST', 'delete', ['root' => '/', 'files' => [$scratch]]), $onStage);
            }
            return;
        }
        abort_unless($source !== null && $payload !== null, 409);
        $expected = ['' => ['payload.zip' => ['file' => true, 'size' => $payload['size']], $destination => ['file' => false]]]
            + $this->archiveTree($files);
        $this->stage('verify_tree', fn () => $this->verifyTree($client, $scratch, $expected), $onStage);
        $this->publishArchiveTree($client, $scratch, $destination, $payload, $beforeWrite, $onStage);
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

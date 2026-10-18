<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

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

    private function read(string $endpoint, array $query, int $limit): PromiseInterface
    {
        $sink = new class($limit) implements StreamInterface {
            use StreamDecoratorTrait;
            private StreamInterface $stream;
            public bool $exceeded = false;
            private int $bytes = 0;
            public function __construct(private int $limit) { $this->stream = Utils::streamFor(''); }
            public function write($string): int {
                $this->bytes += strlen($string);
                if ($this->bytes > $this->limit) { $this->exceeded = true; return 0; }
                return $this->stream->write($string);
            }
        };
        return $this->getHttpClient()->getAsync(sprintf('/api/servers/%s/files/%s', $this->server->uuid, $endpoint), [
            'query' => $query, 'timeout' => 8, 'connect_timeout' => 2,
            'allow_redirects' => false, 'http_errors' => false, 'sink' => $sink,
            'on_headers' => static function (ResponseInterface $response) use ($limit, $sink) {
                if ((float) $response->getHeaderLine('Content-Length') > $limit) {
                    $sink->exceeded = true;
                    throw new \RuntimeException('Bounded response exceeded');
                }
            },
        ])->then(static function (ResponseInterface $response) use ($sink, $limit): string {
            try {
                $status = $response->getStatusCode();
                abort_unless($status === 200, match ($status) { 404 => 404, 401, 403 => 403, default => 502 });
                // Mock transports and handler stacks may return an independent body.
                $body = (string) $response->getBody();
                abort_if($sink->exceeded || strlen($body) > $limit, 413);
                return $body;
            } finally { $sink->close(); }
        }, static function ($error) use ($sink) {
            $exceeded = $sink->exceeded;
            $sink->close();
            abort($exceeded ? 413 : 502);
        });
    }

    public function inspect(string $target, string $guard): array
    {
        $parent = dirname($target);
        $guardParent = dirname($guard);
        $reads = [
            $this->read('list-directory', ['directory' => $parent === '.' ? '/' : '/' . $parent], self::DIRECTORY_BYTES),
            $this->read('contents', ['file' => '/' . $guard], self::GUARD_BYTES),
        ];
        if ($guardParent !== $parent) {
            $reads[] = $this->read('list-directory', ['directory' => $guardParent === '.' ? '/' : '/' . $guardParent], self::DIRECTORY_BYTES);
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

    private function entries(string $directory): array
    {
        return $this->parseEntries($this->read('list-directory', ['directory' => '/' . $directory], self::DIRECTORY_BYTES)->wait());
    }

    private function entriesPair(string $first, string $second): array
    {
        $results = Promises::settle(array_map(fn ($directory) => $this->read('list-directory',
            ['directory' => '/' . $directory], self::DIRECTORY_BYTES), [$first, $second]))->wait();
        foreach ($results as $result) { if ($result['state'] !== 'fulfilled') { throw $result['reason']; } }
        return array_map(fn ($result) => $this->parseEntries($result['value']), $results);
    }

    private function mutate(string $method, string $endpoint, array $body): void
    {
        $response = $this->getHttpClient()->request($method, sprintf('/api/servers/%s/files/%s', $this->server->uuid, $endpoint), [
            'json' => $body, 'timeout' => 30, 'connect_timeout' => 2,
            'allow_redirects' => false, 'http_errors' => false, 'stream' => true,
        ]);
        $status = $response->getStatusCode();
        $response->getBody()->close();
        if ($status !== 204) { throw new \RuntimeException('Filesystem operation not confirmed'); }
    }

    public function commitArchive(string $operationId, string $destination, array $files, ?callable $beforeDispatch = null): void
    {
        $scratch = '.nickhosting-import-' . $operationId;
        // The source archive is produced by Core's validated streaming ZIP encoder.
        // The digest binds the durable request; it does not cause another archive download.
        [$root, $scratchEntries] = $this->entriesPair('', $scratch);
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
        if ($beforeDispatch !== null) { $beforeDispatch(); }
        $this->mutate('POST', 'decompress', ['root' => '/' . $scratch, 'file' => 'payload.zip']);
        // Account for every extracted entry, including denied/ignored paths and empty artifacts.
        // The staging root participates in the first two-read batch, without a serial preflight.
        $deadline = hrtime(true) / 1e9 + 30;
        foreach (array_chunk(array_keys($expected), 2) as $directories) {
            abort_if(hrtime(true) / 1e9 >= $deadline, 504);
            $reads = array_map(fn ($directory) => $this->read('list-directory',
                ['directory' => '/' . $scratch . ($directory === '' ? '' : '/' . $directory)], self::DIRECTORY_BYTES), $directories);
            $results = Promises::settle($reads)->wait();
            foreach ($results as $index => $result) {
                if ($result['state'] !== 'fulfilled') { throw $result['reason']; }
                $entries = $this->parseEntries($result['value']);
                $wanted = $expected[$directories[$index]];
                abort_unless(is_array($entries) && array_is_list($entries) && count($entries) === count($wanted), 409);
                foreach ($entries as $entry) {
                    $item = $wanted[$entry['name']] ?? null;
                    abort_unless($item !== null && ($entry['symlink'] ?? true) === false && $entry['file'] === $item['file']
                        && (!$item['file'] || $entry['size'] === $item['size']), 409);
                    unset($wanted[$entry['name']]);
                }
                abort_unless($wanted === [], 409);
            }
        }
        // A fresh target check belongs immediately before publish, not before decompression.
        foreach ($this->entries('') as $entry) { abort_if(strcasecmp($entry['name'], $destination) === 0, 409); }
        $this->mutate('PUT', 'rename', ['root' => '/', 'files' => [['from' => $scratch . '/' . $destination, 'to' => $destination]]]);
        [$publishedRoot, $remaining] = $this->entriesPair('', $scratch);
        $published = false;
        foreach ($publishedRoot as $entry) {
            if ($entry['name'] === $destination) { $published = $entry['file'] === false && $entry['symlink'] === false; }
        }
        abort_unless($published, 409);
        // Wings rename can return 204 for a missing source. Check both sides before cleanup.
        abort_unless(count($remaining) === 1 && $remaining[0]['name'] === 'payload.zip'
            && $remaining[0]['file'] === true && $remaining[0]['symlink'] === false, 409);
        $this->deleteDirectory($scratch);
    }

    public function deleteDirectory(string $path): void
    {
        $this->mutate('POST', 'delete', ['root' => '/', 'files' => [$path]]);
    }
}

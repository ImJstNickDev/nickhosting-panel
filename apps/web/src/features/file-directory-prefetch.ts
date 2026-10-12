import type { DirectoryBatchResult } from '../../../../packages/pterodactyl-adapter/src/directory-batch.js';
import { filePathCandidates } from './file-path-model.js';
import type { ServerFile } from './service-contracts.js';

export const directoryPrefetchLimits = {
  batch: 48,
  directories: 96,
  depth: 3,
  // Reserve half the work for folders actually visible in the current listing.
  perDepth: [48, 32, 16],
  children: 8,
} as const;

interface Candidate {
  path: string;
  root: string;
  depth: number;
}

/** A navigation-scoped, best-effort metadata scheduler; no foreground errors or downloads. */
export class DirectoryPrefetch {
  private visible = new Set<string>();
  private candidates = new Map<string, Candidate>();
  private visited = new Set<string>();
  private used = [0, 0, 0];
  private controller = new AbortController();
  private running = false;
  private scheduled = false;

  constructor(
    private options: {
      read(path: string): ServerFile[] | undefined;
      fetch(paths: string[], signal: AbortSignal): Promise<DirectoryBatchResult[]>;
      store(path: string, files: ServerFile[]): boolean;
    },
  ) {}

  setVisible(paths: string[]) {
    if (this.controller.signal.aborted) return;
    this.visible = new Set(paths);
    for (const path of paths)
      if (!this.visited.has(path)) this.candidates.set(path, { path, root: path, depth: 1 });
    this.schedule();
  }

  stop() {
    this.controller.abort();
    this.candidates.clear();
  }

  private schedule() {
    if (this.scheduled || this.running || this.controller.signal.aborted) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.run();
    });
  }

  private children(parent: Candidate, files: ServerFile[]) {
    if (parent.depth >= directoryPrefetchLimits.depth) return;
    for (const file of filePathCandidates(files, '')
      .filter((file) => !file.is_file)
      .slice(0, directoryPrefetchLimits.children)) {
      const path = `${parent.path}/${file.name}`;
      if (!this.visited.has(path))
        this.candidates.set(path, { path, root: parent.root, depth: parent.depth + 1 });
    }
  }

  private async run() {
    if (this.running || this.controller.signal.aborted) return;
    this.running = true;
    try {
      while (!this.controller.signal.aborted) {
        const batch: Candidate[] = [];
        for (const item of [...this.candidates.values()].sort((a, b) => a.depth - b.depth)) {
          if (batch.length === directoryPrefetchLimits.batch) break;
          if (!this.visible.has(item.root)) continue;
          this.candidates.delete(item.path);
          if (
            this.visited.has(item.path) ||
            this.visited.size >= directoryPrefetchLimits.directories ||
            (this.used[item.depth - 1] ?? 0) >=
              (directoryPrefetchLimits.perDepth[item.depth - 1] ?? 0)
          )
            continue;
          this.visited.add(item.path);
          this.used[item.depth - 1] = (this.used[item.depth - 1] ?? 0) + 1;
          const cached = this.options.read(item.path);
          if (cached) this.children(item, cached);
          else batch.push(item);
        }
        if (!batch.length) {
          // Cached parents may have added children after the current iteration's snapshot.
          if ([...this.candidates.values()].some((item) => this.visible.has(item.root))) continue;
          break;
        }
        const results = await this.options.fetch(
          batch.map((item) => item.path),
          this.controller.signal,
        );
        if (this.controller.signal.aborted) break;
        for (const item of batch) {
          const result = results.find((result) => result.directory === item.path);
          if (!result || !('files' in result)) continue;
          if (this.options.store(item.path, result.files)) this.children(item, result.files);
        }
      }
    } catch {
      // Optional acceleration never retries or interferes with the open folder's normal query.
      this.stop();
    } finally {
      this.running = false;
    }
  }
}

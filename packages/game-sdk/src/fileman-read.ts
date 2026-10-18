/** Server-side file capabilities supplied by Core after managed-server authorization.
 * Integrations never receive provider credentials or signed URLs. */
export interface FilemanEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink';
  size: number;
}
export type FilemanDirectoryResult =
  | { directory: string; files: readonly FilemanEntry[] }
  | {
      directory: string;
      error: 'not_found' | 'forbidden' | 'unavailable' | 'too_large' | 'deadline_exceeded';
    };
export interface FilemanReadRequest {
  path: string;
  maxBytes: number;
  /** Only an explicit provider 404 counts as missing. */
  missing?: 'allow';
}
export interface FilemanReadService {
  /** Prepare private, one-use read URLs only for files the integration intends to read. */
  prepare(paths: readonly string[]): Promise<void>;
  read(request: FilemanReadRequest): Promise<Uint8Array | undefined>;
  readMany(
    requests: readonly FilemanReadRequest[],
  ): Promise<ReadonlyMap<string, Uint8Array | undefined>>;
  list(directory: string): Promise<readonly FilemanEntry[]>;
  listMany(directories: readonly string[]): Promise<readonly FilemanDirectoryResult[]>;
}

export interface StorageRootOptions {
  workspaceRoot?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Only NH_MOUNTDATA_ROOT is read; false disables private-file lookup. */
  envFile?: string | false;
}
export function resolveStorageRoot(options?: StorageRootOptions): string;
export function assertStorageDirectory(directory: string): string;
export function storagePath(path: string, options?: StorageRootOptions): string;
export function isOutsideWorkspace(path: string, workspaceRoot?: string): boolean;

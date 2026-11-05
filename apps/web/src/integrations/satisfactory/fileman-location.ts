/** Verify known directory components before following an optional game shortcut.
 * A missing optional folder is not an empty directory and is never created here. */
export async function gameDirectoryExists(
  path: string,
  list: (
    parent: string,
  ) => Promise<readonly { name: string; is_file: boolean; is_symlink: boolean }[]>,
  signal: AbortSignal,
): Promise<boolean> {
  let parent = '';
  for (const name of path.split('/')) {
    signal.throwIfAborted();
    const entries = await list(parent);
    signal.throwIfAborted();
    if (!entries.some((entry) => entry.name === name && !entry.is_file && !entry.is_symlink))
      return false;
    parent = parent ? `${parent}/${name}` : name;
  }
  return true;
}

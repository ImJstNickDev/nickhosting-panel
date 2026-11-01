/** Select the basename, retaining the final extension (and its separator) unselected. */
export function filenameSelection(name: string): [number, number] {
  const dot = name.lastIndexOf('.');
  return [0, dot > 0 && dot < name.length - 1 ? dot : name.length];
}

/** A single component of the adapter's relativePath contract, without normalization. */
export function validFilename(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 4096 &&
    name !== '.' &&
    name !== '..' &&
    !/[\\/%]/.test(name) &&
    !Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

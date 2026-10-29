import type { TrustedGameUiModule } from '@nickhosting/game-sdk/ui';

const directoryAssets: Readonly<Record<string, string>> = {
  logs: 'directory-logs',
  mods: 'directory-mods',
  plugins: 'directory-plugins',
  config: 'directory-config',
};

/** World folders may have any name or location; no NBT or extra world permission is needed. */
export const minecraftFileDirectoryIcon: NonNullable<TrustedGameUiModule['fileDirectoryIcon']> = ({
  path,
  entries,
}) => {
  const level = entries.find((entry) => entry.name === 'level.dat');
  if (!level?.is_file || level.is_symlink) {
    const name = path.split('/').at(-1) ?? '';
    const assetId = Object.hasOwn(directoryAssets, name) ? directoryAssets[name] : undefined;
    return assetId ? { assetId } : undefined;
  }
  const icon = entries.find((entry) => entry.name === 'icon.png');
  const file =
    icon?.is_file &&
    !icon.is_symlink &&
    Number.isSafeInteger(icon.size) &&
    icon.size > 0 &&
    icon.size <= 256 * 1024
      ? icon.name
      : undefined;
  return { assetId: 'directory-world', ...(file ? { file } : {}) };
};

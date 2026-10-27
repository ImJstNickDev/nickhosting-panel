import type { TrustedGameUiModule } from '@nickhosting/game-sdk/ui';

/** World folders may have any name or location; no NBT or extra world permission is needed. */
export const minecraftFileDirectoryIcon: NonNullable<TrustedGameUiModule['fileDirectoryIcon']> = ({
  entries,
}) => {
  const level = entries.find((entry) => entry.name === 'level.dat');
  const icon = entries.find((entry) => entry.name === 'icon.png');
  return level?.is_file &&
    !level.is_symlink &&
    icon?.is_file &&
    !icon.is_symlink &&
    Number.isSafeInteger(icon.size) &&
    icon.size > 0 &&
    icon.size <= 256 * 1024
    ? icon.name
    : undefined;
};

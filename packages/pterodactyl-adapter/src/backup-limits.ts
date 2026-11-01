import { z } from 'zod';

/** Wings 1.13 archive limits; comments/escaping follow its gitignore parser. */
export const backupIgnoredSchema = z
  .string()
  .max(16_384)
  .refine((value) => {
    if (Buffer.byteLength(value, 'utf8') > 32_768) return false;
    let patterns = 0;
    for (const raw of value.split('\n')) {
      const line = raw.replace(/\r+$/, '');
      if (line.startsWith('#') || line.replace(/^ +| +$/g, '') === '') continue;
      if (++patterns > 256) return false;
      let wildcards = 0;
      for (let index = 0; index < line.length; index++) {
        if (line[index] === '\\') index++;
        else if (line[index] === '*' && ++wildcards > 16) return false;
      }
    }
    return true;
  });

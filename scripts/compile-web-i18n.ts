import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { compileMessageOrThrow } from '@lingui/message-utils/compileMessage';
import { en, it } from '../packages/i18n/src/catalogs.js';
import { gameUiWebMessages } from '../packages/i18n/src/game-ui-web.js';
import { ownerInfraWebMessages } from '../packages/i18n/src/owner-infra-web.js';
import { ownerWebMessages } from '../packages/i18n/src/owner-web.js';
import { platformWebMessages } from '../packages/i18n/src/platform-web.js';
import { serviceWebMessages } from '../packages/i18n/src/services-web.js';
import { webMessages } from '../packages/i18n/src/web.js';

const catalogs: Record<string, Record<string, string>> = { en: { ...en }, it: { ...it } };
for (const [key, pair] of Object.entries({
  ...webMessages,
  ...platformWebMessages,
  ...serviceWebMessages,
  ...ownerWebMessages,
  ...gameUiWebMessages,
  ...ownerInfraWebMessages,
})) {
  if (!pair[0] || !pair[1]) throw new Error(`Missing translation: ${key}`);
  catalogs.en![key] = pair[0];
  catalogs.it![key] = pair[1];
}
// Game modules contribute only statically reviewed data. The dynamic path below
// is a repository module, never a remote descriptor or Owner-supplied import.
try {
  const { minecraftUiModule } = await import('../games/minecraft/src/ui/index.js');
  Object.assign(catalogs.en!, minecraftUiModule.catalogs.en);
  Object.assign(catalogs.it!, minecraftUiModule.catalogs.it);
} catch (error) {
  // A missing first-party module is a failed build, not a silent empty UI.
  throw error;
}
const allKeys = Object.keys(catalogs.en!).sort();
if (JSON.stringify(allKeys) !== JSON.stringify(Object.keys(catalogs.it!).sort()))
  throw new Error('Catalog parity failed');
const output: Record<string, Record<string, unknown>> = {};
for (const locale of ['en', 'it', 'pseudo']) {
  output[locale] = Object.fromEntries(
    allKeys.map((key) => [
      key,
      compileMessageOrThrow(
        catalogs[locale === 'pseudo' ? 'en' : locale]![key]!,
        locale === 'pseudo' ? (text) => `［${text.replace(/[aeiou]/g, '$&$&')}］` : undefined,
      ),
    ]),
  );
}
const target = new URL('../apps/web/src/app/messages.json', import.meta.url);
const content = `${JSON.stringify(output)}\n`;
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== content) throw new Error('Run pnpm i18n:compile');
} else {
  await mkdir(new URL('../apps/web/src/app/', import.meta.url), { recursive: true });
  await writeFile(target, content);
}
process.stdout.write(`Compiled ${allKeys.length} keys in English, Italian and pseudolocale\n`);

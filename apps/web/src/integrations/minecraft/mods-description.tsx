import { AddonDescription } from '../../components/addon-description.js';
import { useAddonsT } from './addons-context.js';
import { modsKey } from './mods-primitives.js';

export { parseModDescription } from '../../components/addon-description.js';
export function ModsDescription({ text, format }: { text: string; format: 'markdown' | 'html' }) {
  const t = useAddonsT();
  return (
    <AddonDescription text={text} format={format} fallback={t(modsKey('descriptionUnavailable'))} />
  );
}

import { ModsIcon } from '../../components/addon-primitives.js';

export {
  ModsAction,
  ModsArtwork,
  ModsCheckbox,
  ModsEmpty,
  ModsIcon,
  type ModsIconName,
} from '../../components/addon-primitives.js';

import type {
  MinecraftModMetadata,
  ModCatalogProject,
} from '../../../../../games/minecraft/src/ui/mods-controller.js';
import { Pagination } from '../../components/workspace-controls.js';
import { useAddonsT } from './addons-context.js';

export const modsKey = (name: string) => `games.minecraft.mods.${name}`;
const translatedTags = new Set([
  'technology',
  'worldgen',
  'optimization',
  'library',
  'utility',
  'adventure',
]);
export function modTagLabel(tag: { id: string; label: string }, t: (key: string) => string) {
  return translatedTags.has(tag.id) ? t(modsKey(`tag.${tag.id}`)) : tag.label;
}
export function ModsTags({
  side,
  tags = [],
  compact = false,
}: {
  side: MinecraftModMetadata['side'];
  tags?: { id: string; label: string }[];
  compact?: boolean;
}) {
  const t = useAddonsT();
  return (
    <div className="mods-tags">
      <span className="mods-side" data-side={side}>
        {side !== 'unknown' && <ModsIcon name={side} />}
        {t(modsKey(`side.${side}`))}
      </span>
      {(compact ? tags.slice(0, 2) : tags).map((tag) => (
        <span key={tag.id}>{modTagLabel(tag, t)}</span>
      ))}
    </div>
  );
}
export function ModsChannel({ channel }: { channel: 'release' | 'beta' | 'alpha' }) {
  return channel === 'release' ? null : (
    <span className="mods-channel">{channel.toUpperCase()}</span>
  );
}
export function ModsSkeleton({ rows = 5, label }: { rows?: number; label?: string }) {
  const t = useAddonsT();
  return (
    <div className="mods-skeleton" role="status" aria-label={label ?? t(modsKey('loading'))}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i.toString()} aria-hidden="true">
          <i />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
export function ModsPagination({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange(offset: number): void;
}) {
  const t = useAddonsT();
  const pages = Math.max(1, Math.ceil(total / 20));
  return (
    <Pagination
      label={t('web.pagination')}
      previousLabel={t(modsKey('previous'))}
      nextLabel={t(modsKey('next'))}
      summary={t(modsKey('page'), { page: Math.floor(offset / 20) + 1, pages })}
      canPrevious={offset > 0}
      canNext={offset + 20 < total && offset < 9980}
      onPrevious={() => onChange(Math.max(0, offset - 20))}
      onNext={() => onChange(offset + 20)}
    />
  );
}

export function projectIdentity(project: Pick<ModCatalogProject, 'provider' | 'id'>) {
  return `${project.provider}:${project.id}`;
}

import { Link } from 'react-router';
import type { MinecraftModsSnapshot } from '../../../../../games/minecraft/src/ui/mods-controller.js';
import { Dialog } from '../../components/ui.js';
import { addonProviderLabel, useAddonsT } from './addons-context.js';
import { modsKey } from './mods-primitives.js';

export function AddonFileDetails({
  pack,
  serverId,
  canOpenFiles,
  onClose,
}: {
  pack: MinecraftModsSnapshot['packs'][number];
  serverId: string;
  canOpenFiles: boolean;
  onClose(): void;
}) {
  const t = useAddonsT();
  const release = pack.githubRelease;
  const catalog = pack.metadata;
  const facts = [
    ['filePath', pack.path],
    [
      'fileSource',
      release
        ? 'GitHub'
        : catalog
          ? addonProviderLabel[catalog.provider]
          : t(modsKey('fileUnknown')),
    ],
    ...(release
      ? [
          ['fileRepository', release.repository],
          ['fileTag', release.tag],
          ['fileAsset', release.asset],
        ]
      : []),
    ...(catalog
      ? [
          ['fileProject', catalog.projectId],
          ['fileVersion', catalog.versionId],
        ]
      : []),
  ] as [string, string][];
  const separator = pack.path.lastIndexOf('/');
  const query = new URLSearchParams({
    directory: pack.path.slice(0, separator),
    file: pack.path.slice(separator + 1),
  });
  return (
    <Dialog
      open
      closeIcon
      className="addon-file-dialog"
      onClose={onClose}
      title={pack.metadata?.name ?? pack.name}
    >
      <dl className="addon-file-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{t(modsKey(label))}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {canOpenFiles && (
        <div className="form-footer">
          <Link className="button secondary" to={`/servers/${serverId}/files?${query}`}>
            {t(modsKey('fileOpen'))}
          </Link>
        </div>
      )}
    </Dialog>
  );
}

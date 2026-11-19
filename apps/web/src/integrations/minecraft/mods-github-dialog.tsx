import { useRef, useState } from 'react';
import { minecraftGithubModUrlSchema } from '../../../../../games/minecraft/src/mod-contracts.js';
import { ApiError, idempotencyKey } from '../../api/client.js';
import { ActionForm, Dialog, Input, text } from '../../components/ui.js';
import { addonsScopes, useAddonsT } from './addons-context.js';
import { modsKey } from './mods-primitives.js';

export function GithubModDialog({
  serverId,
  revision,
  disabled,
  onClose,
  onStaged,
  refresh,
}: {
  serverId: string;
  revision: number;
  disabled: boolean;
  onClose(): void;
  onStaged(): Promise<void>;
  refresh(): Promise<unknown>;
}) {
  const t = useAddonsT();
  const [busy, setBusy] = useState(false);
  const intent = useRef<{ url: string; revision: number; idempotencyKey: string } | undefined>(
    undefined,
  );
  return (
    <Dialog
      open
      title={t(modsKey('githubInstall'))}
      onClose={onClose}
      className="mods-github-dialog"
      closeIcon
      closeDisabled={busy}
      initialFocusSelector="input[type=url]"
    >
      <ActionForm
        disabled={disabled}
        onBusyChange={setBusy}
        onCancel={onClose}
        success={false}
        submitLabel={t(modsKey('githubPrepare'))}
        onSubmit={async (form) => {
          const url = text(form, 'url');
          if (!minecraftGithubModUrlSchema.safeParse(url).success)
            throw new ApiError('validation_failed', modsKey('githubInvalid'));
          if (intent.current?.url !== url)
            intent.current = { url, revision, idempotencyKey: idempotencyKey() };
          try {
            await addonsScopes.mods.controller.stageGithubMod(serverId, intent.current);
          } catch (error) {
            if (error instanceof ApiError && error.code === 'conflict') intent.current = undefined;
            await refresh();
            throw error;
          }
          await onStaged();
        }}
      >
        <Input
          name="url"
          type="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          label={t(modsKey('githubUrl'))}
          hint={t(modsKey('githubHint'))}
          required
        />
      </ActionForm>
    </Dialog>
  );
}

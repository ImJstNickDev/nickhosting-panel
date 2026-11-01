import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import {
  ActionForm,
  Badge,
  Details,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  number,
  Page,
  Section,
  Select,
  Time,
  text,
} from '../components/ui.js';
import { type Invitation, type InvitationInput, invitationApi } from './owner-invitations-api.js';
import './owner-invitations.css';

type Action = { kind: 'create' } | { kind: 'link' | 'edit' | 'revoke'; invite: Invitation };
function localDate(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function state(invite: Invitation, now: number) {
  return invite.revokedAt
    ? 'revoked'
    : Date.parse(invite.expiresAt) <= now
      ? 'expired'
      : invite.remainingUses === 0
        ? 'exhausted'
        : 'active';
}
function ActionIcon({ kind }: { kind: 'link' | 'edit' | 'revoke' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'link' ? (
        <path
          d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
          transform="translate(1 1)"
        />
      ) : kind === 'edit' ? (
        <path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z" />
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m6 6 12 12" />
        </>
      )}
    </svg>
  );
}

function InvitationLink({ invite, knownUrl }: { invite: Invitation; knownUrl?: string }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(knownUrl);
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the private request without caching its token.
  useEffect(() => {
    if (knownUrl || invite.linkAvailable === false) return;
    const controller = new AbortController();
    setError(undefined);
    void invitationApi.link(invite.id, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setUrl(result.url);
      },
      (cause) => {
        if (!controller.signal.aborted) setError(cause);
      },
    );
    return () => controller.abort();
  }, [invite.id, invite.linkAvailable, knownUrl, attempt]);
  useEffect(() => {
    if (url) input.current?.focus();
  }, [url]);
  if (!url && invite.linkAvailable === false) return <Notice>{t('owner.inviteLegacy')}</Notice>;
  if (error) return <ErrorNotice error={error} retry={() => setAttempt((value) => value + 1)} />;
  if (!url) return <Loading />;
  return (
    <div className="stack">
      <Input
        ref={input}
        label={t('owner.inviteLink')}
        value={url}
        readOnly
        autoComplete="off"
        onFocus={(event) => event.target.select()}
      />
      {knownUrl && invite.linkAvailable !== true && (
        <p className="muted">{t('owner.inviteOnce')}</p>
      )}
      {copyFailed && <p role="alert">{t('owner.inviteCopyFailed')}</p>}
      <div className="actions">
        <button
          type="button"
          disabled={copying}
          onClick={async () => {
            setCopying(true);
            setCopied(false);
            setCopyFailed(false);
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              setCopyFailed(true);
              input.current?.focus();
              input.current?.select();
            } finally {
              setCopying(false);
            }
          }}
        >
          {t('web.copy')}
        </button>
        {copied && <span role="status">{t('web.copied')}</span>}
      </div>
    </div>
  );
}

export function InvitationsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const createButton = useRef<HTMLButtonElement>(null);
  const dialogWasOpen = useRef(false);
  const [action, setAction] = useState<Action>();
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!action && dialogWasOpen.current && document.activeElement === document.body)
      createButton.current?.focus();
    dialogWasOpen.current = Boolean(action);
  }, [action]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: ({ signal }) => invitationApi.list(signal),
  });
  const selected =
    action && action.kind !== 'create'
      ? (invitations.data?.find((invite) => invite.id === action.invite.id) ?? action.invite)
      : undefined;
  const close = () => {
    if (!busy) setAction(undefined);
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['invitations'] });
  };
  const validLink = selected && state(selected, now) === 'active';
  const used = selected ? selected.maxUses - selected.remainingUses : 0;
  return (
    <Page
      title={t('web.invites')}
      actions={
        <button ref={createButton} type="button" onClick={() => setAction({ kind: 'create' })}>
          {t('owner.createInvite')}
        </button>
      }
    >
      <Link className="invitation-back" to="/owner/users">
        ← {t('web.users')}
      </Link>
      <Section>
        {invitations.isPending ? (
          <Loading />
        ) : invitations.error ? (
          <ErrorNotice error={invitations.error} retry={() => void invitations.refetch()} />
        ) : !invitations.data.length ? (
          <Empty />
        ) : (
          <div className="table-scroll invitation-list">
            <table className="invitations-table">
              <thead>
                <tr>
                  <th>{t('web.email')}</th>
                  <th>{t('web.role')}</th>
                  <th>{t('owner.inviteUsed')}</th>
                  <th>{t('web.expires')}</th>
                  <th>{t('web.status')}</th>
                  <th>{t('web.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {invitations.data.map((invite) => {
                  const status = state(invite, now);
                  return (
                    <tr key={invite.id}>
                      <td data-label={t('web.email')}>{invite.email ?? t('owner.anyEmail')}</td>
                      <td data-label={t('web.role')}>{t(`owner.role.${invite.role}`)}</td>
                      <td data-label={t('owner.inviteUsed')}>
                        {invite.maxUses - invite.remainingUses} / {invite.maxUses}
                      </td>
                      <td data-label={t('web.expires')}>
                        <Time value={invite.expiresAt} />
                      </td>
                      <td data-label={t('web.status')}>
                        <Badge
                          value={status}
                          label={status === 'exhausted' ? t('owner.inviteExhausted') : undefined}
                        />
                      </td>
                      <td data-label={t('web.actions')}>
                        <div className="invitation-actions">
                          {(['link', 'edit', 'revoke'] as const)
                            .filter((kind) =>
                              kind === 'link' ? status === 'active' : status !== 'revoked',
                            )
                            .map((kind) => {
                              const label = t(
                                kind === 'link'
                                  ? 'owner.inviteShowLink'
                                  : kind === 'edit'
                                    ? 'owner.inviteEdit'
                                    : 'owner.inviteRevoke',
                              );
                              return (
                                <Tooltip content={label} key={kind}>
                                  <button
                                    type="button"
                                    className={`invitation-action${kind === 'revoke' ? ' invitation-revoke' : ''}`}
                                    aria-label={`${label}: ${invite.email ?? t('owner.anyEmail')}`}
                                    onClick={() => setAction({ kind, invite })}
                                  >
                                    <ActionIcon kind={kind} />
                                  </button>
                                </Tooltip>
                              );
                            })}
                          {status === 'revoked' && <span aria-hidden="true">—</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <Dialog
        open={Boolean(action)}
        title={t(
          action?.kind === 'create'
            ? 'owner.createInvite'
            : action?.kind === 'edit'
              ? 'owner.inviteEdit'
              : action?.kind === 'revoke'
                ? 'owner.inviteRevoke'
                : 'owner.inviteLink',
        )}
        onClose={close}
        closeDisabled={busy}
        closeIcon
      >
        {action?.kind === 'create' && (
          <ActionForm
            key="create"
            submitLabel={t('owner.createInvite')}
            success={false}
            onCancel={close}
            onSubmit={async (data) => {
              const email = text(data, 'email'),
                expires = text(data, 'expires');
              const body: InvitationInput = {
                ...(email ? { email } : {}),
                role: text(data, 'role') as InvitationInput['role'],
                maxUses: number(data, 'uses'),
                ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
              };
              setBusy(true);
              try {
                const response = await invitationApi.create(body);
                setLinks((current) => ({ ...current, [response.id]: response.url }));
                setAction({
                  kind: 'link',
                  invite: {
                    id: response.id,
                    email: body.email ?? null,
                    role: body.role,
                    maxUses: body.maxUses,
                    remainingUses: body.maxUses,
                    expiresAt: response.expiresAt,
                    revokedAt: null,
                    linkAvailable: response.linkAvailable,
                  },
                });
                refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            <Input label={`${t('web.email')} (${t('web.optional')})`} type="email" name="email" />
            <Select label={t('web.role')} name="role">
              <option value="user">{t('owner.role.user')}</option>
              <option value="operator">{t('owner.role.operator')}</option>
            </Select>
            <Input
              label={t('owner.maxUses')}
              type="number"
              name="uses"
              min={1}
              max={100}
              defaultValue={1}
              required
            />
            <Input
              label={t('web.expires')}
              type="datetime-local"
              name="expires"
              min={localDate(new Date(now).toISOString())}
            />
          </ActionForm>
        )}
        {action?.kind === 'link' &&
          selected &&
          (validLink ? (
            <InvitationLink key={selected.id} invite={selected} knownUrl={links[selected.id]} />
          ) : (
            <Notice>
              {t(
                `web.${state(selected, now) === 'exhausted' ? 'unavailable' : state(selected, now)}`,
              )}
            </Notice>
          ))}
        {action?.kind === 'edit' &&
          selected &&
          (selected.revokedAt ? (
            <Notice>{t('web.revoked')}</Notice>
          ) : (
            <ActionForm
              key={`edit-${selected.id}`}
              success={false}
              onCancel={close}
              onSubmit={async (data) => {
                setBusy(true);
                try {
                  const updated = await invitationApi.update(selected.id, {
                    maxUses: number(data, 'uses'),
                    expiresAt:
                      text(data, 'expires') === localDate(selected.expiresAt)
                        ? selected.expiresAt
                        : new Date(text(data, 'expires')).toISOString(),
                  });
                  queryClient.setQueryData<Invitation[]>(['invitations'], (current) =>
                    current?.map((invite) => (invite.id === updated.id ? updated : invite)),
                  );
                  setAction(undefined);
                  refresh();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Details
                values={[
                  [t('web.email'), selected.email ?? t('owner.anyEmail')],
                  [t('web.role'), t(`owner.role.${selected.role}`)],
                ]}
              />
              <p className="muted">{t('owner.inviteImmutable')}</p>
              <Input
                label={t('web.expires')}
                type="datetime-local"
                name="expires"
                defaultValue={localDate(selected.expiresAt)}
                min={localDate(new Date(now).toISOString())}
                required
              />
              <Input
                label={t('owner.maxUses')}
                hint={t('owner.inviteUsedCount', { count: used })}
                type="number"
                name="uses"
                defaultValue={selected.maxUses}
                min={Math.max(1, used)}
                max={100}
                required
              />
              {state(selected, now) !== 'active' && <p>{t('owner.inviteRestoreWarning')}</p>}
            </ActionForm>
          ))}
        {action?.kind === 'revoke' &&
          selected &&
          (selected.revokedAt ? (
            <Notice>{t('web.revoked')}</Notice>
          ) : (
            <ActionForm
              key={`revoke-${selected.id}`}
              submitLabel={t('web.revoke')}
              success={false}
              destructive
              onCancel={close}
              onSubmit={async () => {
                setBusy(true);
                try {
                  await invitationApi.revoke(selected.id);
                  setLinks((current) => {
                    const next = { ...current };
                    delete next[selected.id];
                    return next;
                  });
                  await queryClient.invalidateQueries({ queryKey: ['invitations'] });
                  setAction(undefined);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Details
                values={[
                  [t('web.email'), selected.email ?? t('owner.anyEmail')],
                  [t('web.role'), t(`owner.role.${selected.role}`)],
                  [t('web.expires'), <Time key="expires" value={selected.expiresAt} />],
                ]}
              />
              <p>{t('owner.inviteRevokeWarning')}</p>
            </ActionForm>
          ))}
      </Dialog>
    </Page>
  );
}

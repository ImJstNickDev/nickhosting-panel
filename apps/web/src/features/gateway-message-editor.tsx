import type { GatewayMessageDefinition } from '@nickhosting/game-sdk';
import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useLocale, useT } from '../app/i18n.js';
import { useUnsavedChanges } from '../components/navigation-guard.js';
import { Tooltip } from '../components/tooltip.js';
import { ActionForm, ErrorNotice, Notice, Select } from '../components/ui.js';
import { messageChannels, messagePreview } from './gateway-message-preview.js';
import { getGameGatewayMessageEditor } from './integrations.js';
import { serverPath } from './service-contracts.js';

type MessageOverrides = Record<string, Record<string, string>>;
interface MessagePolicy {
  available: boolean;
  editable: boolean;
  revision: string;
  overrides: MessageOverrides;
  definition?: GatewayMessageDefinition;
}
export function GatewayMessageEditor({ serverId, gameId }: { serverId: string; gameId?: string }) {
  const t = useT();
  const { locale } = useLocale();
  const result = useQuery({
    queryKey: ['gateway-messages', serverId],
    queryFn: () => api<MessagePolicy>(`${serverPath(serverId)}/gateway-messages`),
  });
  if (result.error && !result.data)
    return <ErrorNotice error={result.error} retry={() => void result.refetch()} />;
  if (!result.data)
    return (
      <div
        role="status"
        className="automation-skeleton"
        aria-busy="true"
        aria-label={t('web.loading')}
      />
    );
  if (!result.data.available || !result.data.definition)
    return <Notice>{t('automation.messagesUnavailable')}</Notice>;
  return (
    <>
      {result.error && <ErrorNotice error={result.error} retry={() => void result.refetch()} />}
      <MessageForm
        key={serverId}
        policy={result.data}
        gameId={gameId}
        definition={result.data.definition}
        locale={locale === 'it' ? 'it' : 'en'}
        onSave={async (overrides, revision) => {
          await api(`${serverPath(serverId)}/gateway-messages`, {
            method: 'PUT',
            body: { revision, overrides },
          });
          const refreshed = await result.refetch();
          if (!refreshed.data || refreshed.error) throw refreshed.error;
          return refreshed.data;
        }}
      />
    </>
  );
}
function MessageForm({
  gameId,
  policy,
  definition,
  locale,
  onSave,
}: {
  gameId?: string;
  policy: MessagePolicy;
  definition: GatewayMessageDefinition;
  locale: 'en' | 'it';
  onSave: (overrides: MessageOverrides, revision: string) => Promise<MessagePolicy>;
}) {
  const t = useT();
  const [selected, setSelected] = useState(definition.states[0]?.id ?? '');
  const [draft, setDraft] = useState(policy.overrides);
  const [baseline, setBaseline] = useState(policy);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline.overrides);
  const [saving, setSaving] = useState(false);
  const [focusedChannel, setFocusedChannel] = useState('');
  useUnsavedChanges(dirty, saving);
  useEffect(() => {
    if (!dirty && !saving && policy.revision !== baseline.revision) {
      setBaseline(policy);
      setDraft(policy.overrides);
    }
  }, [policy, baseline.revision, dirty, saving]);
  const fields = useRef<Record<string, HTMLTextAreaElement | HTMLInputElement | null>>({});
  const state = definition.states.find((item) => item.id === selected);
  if (!state) return <Notice>{t('automation.messagesUnavailable')}</Notice>;
  const Extension = getGameGatewayMessageEditor(gameId, definition);
  const channels = messageChannels(definition, state, locale);
  const activeChannel = channels.find((channel) => channel.id === focusedChannel) ?? channels[0];
  const update = (field: string, value: string) =>
    setDraft((previous) => ({
      ...previous,
      [selected]: { ...previous[selected], [field]: value },
    }));
  const insert = (token: string) => {
    if (!activeChannel || !policy.editable) return;
    const field = activeChannel.id;
    const node = fields.current[field];
    const value = draft[selected]?.[field] ?? '';
    const start = node?.selectionStart ?? value.length,
      end = node?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    if (next.length > activeChannel.maxLength) return;
    update(field, next);
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className={`gateway-messages${Extension ? ' gateway-messages-custom' : ''}`}>
      <ActionForm
        submitDisabled={!policy.editable}
        onSubmit={async () => {
          setSaving(true);
          try {
            const saved = await onSave(
              Object.fromEntries(
                Object.entries(draft)
                  .map(([id, value]): [string, Record<string, string>] => [
                    id,
                    Object.fromEntries(Object.entries(value).filter(([, text]) => text.trim())),
                  ])
                  .filter(([, value]) => Object.keys(value).length),
              ),
              baseline.revision,
            );
            setBaseline(saved);
            setDraft(saved.overrides);
          } finally {
            setSaving(false);
          }
        }}
      >
        <Select
          label={t('web.status')}
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            setFocusedChannel('');
          }}
        >
          {definition.states.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label[locale]}
            </option>
          ))}
        </Select>
        {Extension ? (
          <Suspense
            fallback={
              <div
                className="automation-skeleton"
                role="status"
                aria-label={t('web.loading')}
                aria-busy="true"
              />
            }
          >
            <Extension
              key={selected}
              definition={definition}
              state={state}
              locale={locale}
              overrides={draft[selected] ?? {}}
              readOnly={!policy.editable || saving}
              onChange={update}
              onReset={(field) =>
                setDraft((previous) => ({
                  ...previous,
                  [selected]: Object.fromEntries(
                    Object.entries(previous[selected] ?? {}).filter(([key]) => key !== field),
                  ),
                }))
              }
            />
          </Suspense>
        ) : (
          <>
            <div className="gateway-message-fields">
              {channels.map((channel) => {
                const field = channel.id;
                const preview = messagePreview(
                  draft[selected]?.[field] || state.defaults[locale][field] || '',
                  state.previewVariables[locale],
                  channel,
                );
                const inputProps = {
                  id: `gateway-${field}`,
                  ref: (node: HTMLTextAreaElement | HTMLInputElement | null) => {
                    fields.current[field] = node;
                  },
                  value: draft[selected]?.[field] ?? '',
                  placeholder: state.defaults[locale][field],
                  readOnly: !policy.editable,
                  maxLength: channel.maxLength,
                  onFocus: () => setFocusedChannel(field),
                  onChange: (event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
                    update(field, event.target.value),
                };
                return (
                  <div key={field} className="gateway-message-field">
                    <div className="automation-row">
                      <label htmlFor={`gateway-${field}`}>{channel.label[locale]}</label>
                      <Tooltip content={t('automation.resetMessage')}>
                        <button
                          type="button"
                          className="automation-icon"
                          aria-label={t('automation.resetMessage')}
                          disabled={!policy.editable || !draft[selected]?.[field]}
                          onClick={() => update(field, '')}
                        >
                          ↺
                        </button>
                      </Tooltip>
                    </div>
                    {channel.multiline ? (
                      <textarea {...inputProps} rows={4} />
                    ) : (
                      <input {...inputProps} type="text" />
                    )}
                    <div
                      role="img"
                      className="gateway-preview"
                      aria-label={`${t('automation.preview')}: ${preview.map((run) => run.text).join('')}`}
                    >
                      {preview.map((run, index) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: Stateless text runs are indexed by their position in this immutable preview.
                          key={index}
                          style={{
                            color: run.style.color,
                            fontWeight: run.style.bold ? 700 : undefined,
                            fontStyle: run.style.italic ? 'italic' : undefined,
                            textDecoration:
                              [
                                run.style.underline ? 'underline' : '',
                                run.style.strike ? 'line-through' : '',
                              ]
                                .filter(Boolean)
                                .join(' ') || undefined,
                          }}
                        >
                          {run.text}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {(definition.variables.length > 0 || !!activeChannel?.formatting?.tokens.length) && (
              <div className="automation-token-row">
                <span>{t('automation.insert')}</span>
                {definition.variables.map((variable) => (
                  <button
                    type="button"
                    className="automation-token"
                    key={variable.id}
                    disabled={!policy.editable || !activeChannel}
                    onClick={() => insert(`{${variable.id}}`)}
                  >
                    {variable.label[locale]}
                  </button>
                ))}
                {!!activeChannel?.formatting?.tokens.length && (
                  <Select
                    label={t('automation.formatting')}
                    className="automation-label-hidden"
                    disabled={!policy.editable}
                    value=""
                    onChange={(event) => {
                      if (event.target.value) insert(event.target.value);
                    }}
                  >
                    <option value="">{t('automation.formatting')}</option>
                    {activeChannel.formatting.tokens.map((token) => (
                      <option value={token.value} key={token.value}>
                        {token.label[locale]}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            )}
            <p className="muted automation-preview-note">{t('automation.previewHint')}</p>
          </>
        )}
      </ActionForm>
    </div>
  );
}

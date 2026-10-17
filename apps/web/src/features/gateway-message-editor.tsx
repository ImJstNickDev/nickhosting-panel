import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useLocale, useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import { ActionForm, ErrorNotice, Notice, Select } from '../components/ui.js';
import { serverPath, useServer } from './service-contracts.js';

type Messages = { motd?: string; disconnect?: string };
interface MessagePolicy {
  available: boolean;
  editable: boolean;
  revision: string;
  overrides: Record<string, Messages>;
  states: Array<{
    id: string;
    stateText: { en: string; it: string };
    defaults: { en: Required<Messages>; it: Required<Messages> };
  }>;
  variables: string[];
}
const colors: Record<string, string> = {
  0: '#000',
  1: '#0000aa',
  2: '#00aa00',
  3: '#00aaaa',
  4: '#aa0000',
  5: '#aa00aa',
  6: '#ffaa00',
  7: '#aaa',
  8: '#555',
  9: '#5555ff',
  a: '#55ff55',
  b: '#55ffff',
  c: '#ff5555',
  d: '#ff55ff',
  e: '#ffff55',
  f: '#fff',
};
function ColoredMessage({ value }: { value: string }) {
  let color: string | undefined;
  let bold = false,
    italic = false,
    underline = false,
    strike = false;
  return value.split(/(§[0-9a-fklmnor])/gi).map((part, index) => {
    if (/^§[0-9a-fklmnor]$/i.test(part)) {
      const code = part.charAt(1).toLowerCase();
      if (colors[code] || code === 'r') {
        color = colors[code];
        bold = italic = underline = strike = false;
      } else if (code === 'l') bold = true;
      else if (code === 'o') italic = true;
      else if (code === 'n') underline = true;
      else if (code === 'm') strike = true;
      return null;
    }
    return (
      <span
        // biome-ignore lint/suspicious/noArrayIndexKey: Stateless text runs are indexed by their position in this immutable preview.
        key={`${index}-${part}`}
        style={{
          color,
          fontWeight: bold ? 700 : undefined,
          fontStyle: italic ? 'italic' : undefined,
          textDecoration:
            [underline ? 'underline' : '', strike ? 'line-through' : '']
              .filter(Boolean)
              .join(' ') || undefined,
        }}
      >
        {part}
      </span>
    );
  });
}
export function GatewayMessageEditor({ serverId }: { serverId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const server = useServer(serverId);
  const result = useQuery({
    queryKey: ['gateway-messages', serverId],
    queryFn: () => api<MessagePolicy>(`${serverPath(serverId)}/gateway-messages`),
  });
  if (result.error && !result.data) return <ErrorNotice error={result.error} />;
  if (!result.data)
    return (
      <div
        role="status"
        className="automation-skeleton"
        aria-busy="true"
        aria-label={t('web.loading')}
      />
    );
  if (!result.data.available) return <Notice>{t('automation.messagesUnavailable')}</Notice>;
  return (
    <>
      {result.error && <ErrorNotice error={result.error} />}
      <MessageForm
        key={result.data.revision}
        policy={result.data}
        serverName={server.data?.name ?? ''}
        locale={locale === 'it' ? 'it' : 'en'}
        onSave={async (overrides) => {
          await api(`${serverPath(serverId)}/gateway-messages`, {
            method: 'PUT',
            body: { revision: result.data?.revision, overrides },
          });
          await result.refetch();
        }}
      />
    </>
  );
}
function MessageForm({
  policy,
  serverName,
  locale,
  onSave,
}: {
  policy: MessagePolicy;
  serverName: string;
  locale: 'en' | 'it';
  onSave: (overrides: Record<string, Messages>) => Promise<void>;
}) {
  const t = useT();
  const [selected, setSelected] = useState(policy.states[0]?.id ?? 'sleeping');
  const [draft, setDraft] = useState(policy.overrides);
  const lastField = useRef<'motd' | 'disconnect'>('motd');
  const fields = useRef<Partial<Record<'motd' | 'disconnect', HTMLTextAreaElement | null>>>({});
  const state = policy.states.find((item) => item.id === selected);
  if (!state) return <Notice>{t('automation.messagesUnavailable')}</Notice>;
  const update = (field: keyof Messages, value: string) =>
    setDraft((previous) => ({
      ...previous,
      [selected]: { ...previous[selected], [field]: value },
    }));
  const insert = (token: string) => {
    const field = lastField.current;
    const node = fields.current[field];
    const value = draft[selected]?.[field] ?? '';
    const start = node?.selectionStart ?? value.length,
      end = node?.selectionEnd ?? value.length;
    update(field, value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      node?.focus();
      node?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const preview = (field: keyof Messages) =>
    (draft[selected]?.[field] || state.defaults[locale][field]).replace(
      /\{(server|state|eta)\}/g,
      (_, name: string) =>
        name === 'server'
          ? serverName
          : name === 'state'
            ? (state.stateText?.[locale] ?? state.defaults[locale].disconnect)
            : '',
    );
  return (
    <div className="gateway-messages">
      <ActionForm
        submitDisabled={!policy.editable}
        onSubmit={() =>
          onSave(
            Object.fromEntries(
              Object.entries(draft)
                .map(([id, value]): [string, Record<string, string>] => [
                  id,
                  Object.fromEntries(Object.entries(value).filter(([, text]) => text.trim())),
                ])
                .filter(([, value]) => Object.keys(value).length),
            ),
          )
        }
      >
        <Select
          label={t('web.status')}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {policy.states.map((item) => (
            <option key={item.id} value={item.id}>
              {t(`automation.state.${item.id}`)}
            </option>
          ))}
        </Select>
        <div className="gateway-message-fields">
          {(['motd', 'disconnect'] as const).map((field) => (
            <div key={field} className="gateway-message-field">
              <div className="automation-row">
                <label htmlFor={`gateway-${field}`}>{t(`automation.${field}`)}</label>
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
              <textarea
                id={`gateway-${field}`}
                ref={(node) => {
                  fields.current[field] = node;
                }}
                value={draft[selected]?.[field] ?? ''}
                placeholder={state.defaults[locale][field]}
                readOnly={!policy.editable}
                maxLength={512}
                rows={4}
                onFocus={() => {
                  lastField.current = field;
                }}
                onChange={(event) => update(field, event.target.value)}
              />
              <div
                role="img"
                className="gateway-preview"
                aria-label={`${t('automation.preview')}: ${preview(field).replace(/§[0-9a-fklmnor]/gi, '')}`}
              >
                <ColoredMessage value={preview(field)} />
              </div>
            </div>
          ))}
        </div>
        <div className="automation-token-row">
          <span>{t('automation.insert')}</span>
          {policy.variables.map((variable) => (
            <button
              type="button"
              className="automation-token"
              key={variable}
              disabled={!policy.editable}
              onClick={() => insert(`{${variable}}`)}
            >
              {t(`automation.variable.${variable}`)}
            </button>
          ))}
          <Select
            label={t('automation.color')}
            className="automation-label-hidden"
            disabled={!policy.editable}
            value=""
            onChange={(event) => {
              if (event.target.value) insert(`§${event.target.value}`);
            }}
          >
            <option value="">{t('automation.color')}</option>
            {['a', 'b', 'c', 'd', 'e', 'f', '7', '6', 'r'].map((color) => (
              <option value={color} key={color}>
                {t(`automation.color.${color}`)}
              </option>
            ))}
          </Select>
        </div>
        <p className="muted automation-preview-note">{t('automation.previewHint')}</p>
      </ActionForm>
    </div>
  );
}

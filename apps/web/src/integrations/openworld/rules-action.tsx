import { type FormEvent, useRef, useState } from 'react';
import {
  type OpenworldDifficulty,
  type OpenworldRuleAction,
  openworldDifficulties,
} from '../../../../../games/openworld/src/rules.js';
import { ApiError, api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Dialog, ErrorNotice, Select } from '../../components/ui.js';

const key = (suffix: string) => `games.openworld.rules.${suffix}`;
export type RuleForm = { kind: 'difficulty' } | { kind: 'unban'; uuid: string; name: string };

export function RuleActionDialog({
  form,
  serverId,
  processRef,
  difficulty,
  onClose,
  onSaved,
}: {
  form: RuleForm;
  serverId: string;
  processRef: string;
  difficulty: OpenworldDifficulty | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState<OpenworldDifficulty | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const sending = useRef(false);
  const locked =
    error instanceof ApiError &&
    (error.code === 'operation_uncertain' || [401, 403, 404, 409].includes(error.status));
  const title = t(key(form.kind === 'difficulty' ? 'changeDifficulty' : 'unban'));
  const label = form.kind === 'difficulty' ? t('web.save') : t(key('unban'));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || locked) return;
    let action: OpenworldRuleAction;
    if (form.kind === 'difficulty') {
      if (!value || value === difficulty) return;
      action = { kind: form.kind, value };
    } else {
      action = {
        kind: form.kind,
        uuid: form.uuid,
      };
    }
    const requestId = crypto.randomUUID();
    setBusy(true);
    sending.current = true;
    setError(undefined);
    try {
      const receipt = await api<{ requestId: string; outcome: string }>(
        `/v1/servers/${encodeURIComponent(serverId)}/openworld/rules`,
        { body: { processRef, requestId, action } },
      );
      if (receipt.requestId !== requestId || receipt.outcome !== 'accepted')
        throw Error('missing_receipt');
      onSaved();
    } catch (e) {
      setError(
        e instanceof ApiError && !(e.code === 'internal_error' && e.status >= 500)
          ? e
          : new ApiError('operation_uncertain', 'errors.operation_uncertain', requestId),
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      title={title}
      closeIcon
      closeDisabled={busy}
      className="ow-detail ow-rules-dialog"
      initialFocusSelector={form.kind === 'difficulty' ? 'select' : '[data-cancel]'}
      onClose={() => {
        if (!sending.current) onClose();
      }}
    >
      <form onSubmit={submit} aria-busy={busy}>
        {error ? <ErrorNotice error={error} /> : null}
        {form.kind === 'difficulty' && (
          <Select
            name="difficulty"
            label={t(key('difficulty'))}
            value={value}
            required
            disabled={busy || locked}
            onChange={(e) => setValue(e.target.value as OpenworldDifficulty)}
          >
            <option value="" disabled>
              {t(key('chooseDifficulty'))}
            </option>
            {openworldDifficulties
              .filter((d) => d !== difficulty)
              .map((d) => (
                <option key={d} value={d}>
                  {t(key(d))}
                </option>
              ))}
          </Select>
        )}
        {form.kind === 'unban' && (
          <div>
            <p>{t(key('unbanPrompt'), { name: form.name || form.uuid })}</p>
            {form.name && <small className="ow-rule-uuid">{form.uuid}</small>}
          </div>
        )}
        <footer>
          <button className="secondary" data-cancel type="button" disabled={busy} onClick={onClose}>
            {t(locked ? 'web.close' : 'web.cancel')}
          </button>
          <button type="submit" disabled={busy || locked || (form.kind === 'difficulty' && !value)}>
            {label}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

import { type FormEvent, useRef, useState } from 'react';
import {
  type OpenworldRuleAction,
  openworldRuleActionSchema,
} from '../../../../../games/openworld/src/rules.js';
import { ApiError, api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Dialog, ErrorNotice, Input, Select } from '../../components/ui.js';
import { useRuleText } from './rules-fields.js';

export type FormField = {
  name: string;
  label: string;
  initial?: string;
  hint?: string;
  kind?: 'number' | 'text' | 'color' | 'choice' | 'select';
  options?: { value: string; label: string; description?: string }[];
  suggestions?: string[];
  min?: number;
  max?: number;
  step?: number | 'any';
  maxLength?: number;
  pattern?: string;
  optional?: boolean;
};
export type RuleForm = {
  title: string;
  subject?: string;
  description?: string;
  fields?: FormField[];
  confirm?: string;
  destructive?: boolean;
  applied?: (action: OpenworldRuleAction) => void;
  action: (values: Record<string, string>) => OpenworldRuleAction | null;
};
export type OpenRuleForm = (form: RuleForm) => void;

export function RuleActionDialog({
  form,
  serverId,
  processRef,
  onClose,
  onSaved,
  onAccessError,
}: {
  form: RuleForm;
  serverId: string;
  processRef: string;
  onClose: () => void;
  onSaved: () => void;
  onAccessError: () => void;
}) {
  const t = useT(),
    r = useRuleText(),
    sending = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const fields = form.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.initial ?? ''])),
  );
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  const locked =
    error instanceof ApiError &&
    (error.code === 'operation_uncertain' || [401, 403, 404, 409].includes(error.status));
  const action = form.action(values);
  const valid = action && openworldRuleActionSchema.safeParse(action).success;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || !action || sending.current || locked) return;
    const requestId = crypto.randomUUID();
    sending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await api<{ requestId: string; outcome: string }>(
        `/v1/servers/${encodeURIComponent(serverId)}/openworld/rules`,
        { body: { processRef, requestId, action } },
      );
      if (receipt.requestId !== requestId || receipt.outcome !== 'accepted')
        throw Error('missing_receipt');
      form.applied?.(action);
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof ApiError && !(cause.code === 'internal_error' && cause.status >= 500)
          ? cause
          : new ApiError('operation_uncertain', 'errors.operation_uncertain', requestId),
      );
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) onAccessError();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      closeIcon
      closeDisabled={busy}
      title={form.title}
      className="ow-detail ow-rules-dialog"
      initialFocusSelector={form.destructive ? '[data-cancel]' : undefined}
      onClose={() => {
        if (!sending.current) onClose();
      }}
    >
      <form onSubmit={submit} aria-busy={busy}>
        {form.subject && <p className="ow-rule-dialog-subject">{form.subject}</p>}
        {form.description && <p>{form.description}</p>}
        {error ? <ErrorNotice error={error} /> : null}
        {fields.map((field) => {
          const value = values[field.name] ?? '',
            options = field.options ?? [];
          if (field.kind === 'choice')
            return (
              <fieldset key={field.name} className="ow-rule-choices" disabled={busy || locked}>
                <legend>{field.label}</legend>
                {options.map((o) => (
                  <label key={o.value} data-selected={o.value === value}>
                    <input
                      type="radio"
                      name={field.name}
                      value={o.value}
                      checked={value === o.value}
                      onChange={() => set(field.name, o.value)}
                    />
                    <span>
                      <strong>{o.label}</strong>
                      {o.description && <small>{o.description}</small>}
                    </span>
                  </label>
                ))}
              </fieldset>
            );
          if (field.kind === 'select')
            return (
              <Select
                key={field.name}
                name={field.name}
                label={field.label}
                required={!field.optional}
                value={value}
                disabled={busy || locked}
                onChange={(e) => set(field.name, e.target.value)}
              >
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            );
          const list = field.suggestions?.length ? `rule-suggestions-${field.name}` : undefined;
          return (
            <div key={field.name}>
              <Input
                name={field.name}
                label={field.label}
                hint={field.hint}
                type={field.kind ?? 'text'}
                autoComplete="off"
                value={value}
                list={list}
                required={!field.optional}
                maxLength={field.maxLength}
                pattern={field.pattern}
                disabled={busy || locked}
                min={field.min}
                max={field.max}
                step={field.step}
                onChange={(e) => set(field.name, e.target.value)}
              />
              {list && (
                <datalist id={list}>
                  {field.suggestions?.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              )}
            </div>
          );
        })}
        <footer>
          <button type="button" data-cancel className="secondary" disabled={busy} onClick={onClose}>
            {t(locked ? 'web.close' : 'web.cancel')}
          </button>
          <button
            className={form.destructive ? 'danger' : undefined}
            type="submit"
            disabled={busy || locked || !valid}
          >
            {busy ? r('saving') : (form.confirm ?? t('web.save'))}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

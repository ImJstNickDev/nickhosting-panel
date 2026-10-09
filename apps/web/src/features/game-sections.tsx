import {
  type GameUiContext,
  type TrustedGameUiModule,
  type UiField,
  type UiForm,
  type UiOption,
  type UiSectionData,
  type UiValues,
  uiOptionSchema,
  validateUiValues,
  visibleFields,
} from '@nickhosting/game-sdk/ui';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, api, idempotencyKey } from '../api/client.js';
import { hashFile } from '../api/hash.js';
import { useT } from '../app/i18n.js';
import {
  Check,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  JobNotice,
  Loading,
  Notice,
  Section,
  Select,
  Textarea,
  Time,
} from '../components/ui.js';
import { gameUiClient, gameUiRegistry } from './integrations.js';
import { useServer } from './service-contracts.js';

export function GameFields({
  module,
  fields,
  values,
  onChange,
  serverId,
  disabled = false,
  errors = {},
  onChoices,
  refreshToken = 0,
}: {
  module: TrustedGameUiModule;
  fields: readonly UiField[];
  values: UiValues;
  onChange: (id: string, value: unknown) => void;
  serverId?: string;
  disabled?: boolean;
  errors?: Record<string, string>;
  onChoices?: (field: string, choices: UiOption[]) => void;
  refreshToken?: number;
}) {
  return (
    <>
      {visibleFields(fields, values).map((field) => (
        <GameField
          key={field.id}
          {...{ module, field, values, onChange, serverId, disabled, onChoices, refreshToken }}
          error={errors[field.id]}
        />
      ))}
    </>
  );
}
function GameField({
  module,
  field,
  values,
  onChange,
  serverId,
  disabled,
  error,
  onChoices,
  refreshToken,
}: {
  module: TrustedGameUiModule;
  field: UiField;
  values: UiValues;
  onChange: (id: string, value: unknown) => void;
  serverId?: string;
  disabled: boolean;
  error?: string;
  onChoices?: (field: string, choices: UiOption[]) => void;
  refreshToken: number;
}) {
  const t = useT(),
    id = useId();
  const value = values[field.id];
  const [multiline, setMultiline] = useState(Array.isArray(value) ? value.join('\n') : '');
  const [options, setOptions] = useState<UiOption[]>(field.type === 'choice' ? field.options : []),
    [loading, setLoading] = useState(false),
    [failure, setFailure] = useState<unknown>();
  const [progress, setProgress] = useState<{
      phase: 'hashing' | 'uploading';
      sent: number;
      total: number;
    }>(),
    [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<{ name: string; uuid: string; input: string }>();
  const [archiveName, setArchiveName] = useState<string>();
  const [fileSelection, setFileSelection] = useState(0);
  const transfer = useRef<AbortController | undefined>(undefined);
  const requestKey = useRef<string | undefined>(undefined);
  const depends =
    field.type === 'choice' && field.source
      ? JSON.stringify(
          Object.fromEntries(field.source.dependsOn.map((key) => [key, values[key] ?? null])),
        )
      : '';
  const handler = field.type === 'choice' ? field.source?.handler : undefined;
  const notifyChoices = useRef(onChoices);
  notifyChoices.current = onChoices;
  // biome-ignore lint/correctness/useExhaustiveDependencies: confirmed jobs must refresh remote choices even when the form dependencies did not change.
  useEffect(() => {
    if (!handler) return;
    const abort = new AbortController();
    setLoading(true);
    setFailure(undefined);
    Promise.resolve()
      .then(() =>
        module.handlers[handler]?.(gameUiClient, {
          serverId,
          values: JSON.parse(depends),
          signal: abort.signal,
        }),
      )
      .then((result) => {
        if (abort.signal.aborted) return;
        const parsed = z.array(uiOptionSchema).max(10000).parse(result);
        setOptions(parsed);
        notifyChoices.current?.(field.id, parsed);
      })
      .catch((error) => {
        if (!abort.signal.aborted) {
          setFailure(error);
          setOptions([]);
          notifyChoices.current?.(field.id, []);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
    // Values referenced by a choices handler are explicitly declared in its descriptor.
  }, [handler, depends, module, serverId, field.id, refreshToken]);
  useEffect(() => () => transfer.current?.abort(), []);
  useEffect(() => {
    if (field.type === 'archive' && !value && !busy) setArchiveName(undefined);
  }, [field.type, value, busy]);
  const hint = field.helpKey ? t(field.helpKey) : undefined;
  async function upload(file: File) {
    if (field.type !== 'archive' || busy) return;
    const abort = new AbortController();
    transfer.current = abort;
    setBusy(true);
    setFailure(undefined);
    setArchiveName(file.name);
    onChange(field.id, undefined);
    requestKey.current = idempotencyKey();
    try {
      setProgress({ phase: 'hashing', sent: 0, total: file.size });
      const sha256 = await hashFile(file, {
        signal: abort.signal,
        onProgress: (sent) => setProgress({ phase: 'hashing', sent, total: file.size }),
      });
      setProgress({ phase: 'uploading', sent: 0, total: file.size });
      const client = {
        ...gameUiClient,
        upload: (path: string, body: Blob, options: { bytes: number; signal?: AbortSignal }) =>
          gameUiClient.upload?.(path, body, {
            ...options,
            onProgress: (sent, total) => setProgress({ phase: 'uploading', sent, total }),
          }),
      };
      const result = z
        .object({ id: z.uuid(), state: z.literal('ready') })
        .passthrough()
        .parse(
          await module.handlers[field.handler]?.(client as typeof gameUiClient, {
            serverId,
            values: { file, sha256 },
            signal: abort.signal,
            idempotencyKey: requestKey.current,
          }),
        );
      onChange(field.id, result.id);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError')
        setFailure(new ApiError('cancelled', 'gameUi.transferCancelled'));
      else setFailure(cause);
    } finally {
      setBusy(false);
      setProgress(undefined);
      transfer.current = undefined;
      setFileSelection((previous) => previous + 1);
    }
  }
  async function lookup() {
    if ((field.type !== 'text' && field.type !== 'textarea') || !field.lookupHandler) return;
    setBusy(true);
    setFailure(undefined);
    setIdentity(undefined);
    try {
      const result = z.object({ name: z.string(), uuid: z.string() }).parse(
        await module.handlers[field.lookupHandler]?.(gameUiClient, {
          serverId,
          values: { [field.id]: value },
        }),
      );
      setIdentity({ ...result, input: String(value) });
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    if (field.type !== 'preview') return;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = z
        .array(z.string())
        .max(field.maxItems)
        .parse(await module.handlers[field.handler]?.(gameUiClient, { serverId, values }));
      onChange(field.id, result);
    } catch (cause) {
      setFailure(cause);
    } finally {
      setBusy(false);
    }
  }
  const shared = {
    id,
    disabled: disabled || busy,
    'aria-invalid': Boolean(error),
    'aria-describedby': error ? `${id}-error` : undefined,
  };
  return (
    <div className="stack">
      {field.type === 'boolean' ? (
        <Check
          {...shared}
          label={t(field.labelKey)}
          checked={value === true}
          required={field.required && field.mustBeTrue}
          onChange={(event) => onChange(field.id, event.target.checked)}
        />
      ) : null}
      {field.type === 'text' || field.type === 'textarea' ? (
        field.type === 'textarea' ? (
          <Textarea
            {...shared}
            label={t(field.labelKey)}
            value={typeof value === 'string' ? value : ''}
            required={field.required}
            minLength={field.minLength}
            maxLength={field.maxLength}
            onChange={(event) => onChange(field.id, event.target.value)}
          />
        ) : (
          <Input
            {...shared}
            label={t(field.labelKey)}
            hint={hint}
            value={typeof value === 'string' ? value : ''}
            required={field.required}
            minLength={field.minLength}
            maxLength={field.maxLength}
            onChange={(event) => onChange(field.id, event.target.value)}
          />
        )
      ) : null}
      {field.type === 'number' ? (
        <Input
          {...shared}
          label={t(field.labelKey)}
          type="number"
          min={field.min}
          max={field.max}
          step={field.integer ? 1 : 'any'}
          required={field.required}
          value={typeof value === 'number' ? value : ''}
          onChange={(event) =>
            onChange(field.id, event.target.value === '' ? undefined : Number(event.target.value))
          }
        />
      ) : null}
      {field.type === 'choice' ? (
        <>
          <Select
            {...shared}
            label={t(field.labelKey)}
            required={field.required}
            disabled={disabled || loading || busy}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(field.id, event.target.value)}
          >
            <option value="">
              {loading
                ? t('web.loading')
                : options.length
                  ? t('gameUi.select')
                  : t('gameUi.noOptions')}
            </option>
            {options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.labelKey ? t(option.labelKey) : option.label}
              </option>
            ))}
          </Select>
          {loading && <span role="status">{t('web.loading')}</span>}
        </>
      ) : null}
      {field.type === 'multi-text' ? (
        <Textarea
          {...shared}
          label={t(field.labelKey)}
          value={multiline}
          required={field.required}
          onChange={(event) => {
            setMultiline(event.target.value);
            onChange(
              field.id,
              event.target.value
                .split(/\r?\n/)
                .filter((line) => line.trim())
                .map((line) => line.trim()),
            );
          }}
        />
      ) : null}
      {field.type === 'archive' ? (
        <>
          <Input
            key={fileSelection}
            {...shared}
            label={t(field.labelKey)}
            type="file"
            accept={field.accept.join(',')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          {typeof value === 'string' && (
            <p role="status">
              <span>{t('gameUi.archived')}</span>
              {archiveName && <>: {archiveName}</>}
            </p>
          )}
          {progress && (
            <>
              <label htmlFor={`${id}-progress`}>{t(`gameUi.${progress.phase}`)}</label>
              <progress id={`${id}-progress`} value={progress.sent} max={progress.total} />
              <button type="button" className="secondary" onClick={() => transfer.current?.abort()}>
                {t('web.cancel')}
              </button>
            </>
          )}
        </>
      ) : null}
      {field.type === 'archive' && field.catalog && (
        <ArchiveCatalog
          module={module}
          field={field}
          serverId={serverId}
          disabled={disabled || busy}
          onSelected={(id) => onChange(field.id, id)}
        />
      )}
      {field.type === 'preview' ? (
        <>
          <button
            type="button"
            className="secondary"
            disabled={disabled || busy}
            onClick={() => void preview()}
          >
            {t(field.labelKey)}
          </button>
          {Array.isArray(value) ? (
            value.length ? (
              <ul>
                {value.map((path) => (
                  <li key={String(path)}>
                    <code>{String(path)}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t('gameUi.emptyPreview')}</p>
            )
          ) : (
            <p>{t('gameUi.previewRequired')}</p>
          )}
        </>
      ) : null}
      {field.type === 'file' ? (
        <Input
          {...shared}
          label={t(field.labelKey)}
          type="file"
          accept={field.accept.join(',')}
          required={field.required}
          onChange={(event) => onChange(field.id, event.target.files?.[0])}
        />
      ) : null}
      {(field.type === 'text' || field.type === 'textarea') && field.lookupHandler && (
        <>
          <button
            type="button"
            className="secondary"
            disabled={disabled || busy || !value}
            onClick={() => void lookup()}
          >
            {t('gameUi.lookup')}
          </button>
          {identity && identity.input === value && (
            <p role="status">
              {t('gameUi.verifiedIdentity')}: {identity.name} <code>{identity.uuid}</code>
            </p>
          )}
        </>
      )}
      {field.documentation && (
        <a href={field.documentation.url} target="_blank" rel="noreferrer">
          {t(field.documentation.labelKey)}
        </a>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {t(`gameUi.${error}`)}
        </p>
      )}
      {failure !== undefined && <ErrorNotice error={failure} />}
    </div>
  );
}

export function GameSections({
  serverId,
  sectionId,
  gameId,
}: {
  serverId: string;
  sectionId: string;
  gameId: string;
}) {
  const t = useT(),
    server = useServer(serverId),
    module = gameUiRegistry.get(gameId),
    section = module?.descriptor.sections.find((s) => s.id === sectionId);
  const permissions = Object.entries(server.data?.permissions ?? {}).flatMap(([name, allowed]) =>
    allowed ? [`server:${name}`] : [],
  );
  const canReadSection = Boolean(
    section?.requiredPermissions.every((permission) => permissions.includes(permission)),
  );
  const loaded = useQuery({
    queryKey: ['game-section', serverId, gameId, sectionId],
    enabled: Boolean(module && section && canReadSection),
    queryFn: ({ signal }) =>
      module?.handlers[section?.loader ?? '']?.(gameUiClient, {
        serverId,
        values: {},
        signal,
      }) as Promise<UiSectionData>,
  });
  const [operationId, setOperationId] = useState<string>();
  const [completedOperationId, setCompletedOperationId] = useState<string>();
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshedOperation = useRef<string | undefined>(undefined);
  const operationServer = useRef(serverId);
  useEffect(() => {
    if (operationServer.current === serverId) return;
    operationServer.current = serverId;
    refreshedOperation.current = undefined;
    setOperationId(undefined);
    setCompletedOperationId(undefined);
    setRefreshToken(0);
  }, [serverId]);
  const operation = useQuery({
    queryKey: ['game-operation', operationId],
    enabled: Boolean(operationId),
    queryFn: ({ signal }) =>
      api<{ state: string; effectState: string | null }>(`/v1/platform/jobs/${operationId}`, {
        signal,
      }),
    refetchInterval: (query) =>
      query.state.data && ['succeeded', 'failed'].includes(query.state.data.state) ? false : 1000,
  });
  const operationState = operation.data?.state;
  const effectState = operation.data?.effectState;
  useEffect(() => {
    if (
      !operationId ||
      !operation.dataUpdatedAt ||
      !operationState ||
      !['succeeded', 'failed'].includes(operationState) ||
      refreshedOperation.current === operationId
    )
      return;
    let cancelled = false;
    void Promise.all([loaded.refetch(), server.refetch()]).then(([sectionResult, serverResult]) => {
      if (cancelled || sectionResult.error || serverResult.error) return;
      refreshedOperation.current = operationId;
      setRefreshToken((previous) => previous + 1);
      if (operationState === 'succeeded' && effectState === 'confirmed')
        setCompletedOperationId(operationId);
    });
    return () => {
      cancelled = true;
    };
  }, [
    operationId,
    operationState,
    effectState,
    operation.dataUpdatedAt,
    loaded.refetch,
    server.refetch,
  ]);
  const pendingOperation = Boolean(
    operationId &&
      (!operation.data ||
        ['queued', 'running'].includes(operation.data.state) ||
        refreshedOperation.current !== operationId),
  );
  if (!module || !section) return <Empty text={t('gameUi.missingSection')} />;
  if (server.isPending) return <Loading />;
  if (server.error) return <ErrorNotice error={server.error} />;
  if (!canReadSection) return <Notice>{t('gameUi.noPermission')}</Notice>;
  if (loaded.isPending) return <Loading />;
  if (server.error || loaded.error)
    return (
      <ErrorNotice
        error={server.error ?? loaded.error}
        retry={() => {
          void server.refetch();
          void loaded.refetch();
          if (operationId) void operation.refetch();
        }}
      />
    );
  if (!server.data || !loaded.data) return <Empty />;

  if (!section.requiredPermissions.every((permission) => permissions.includes(permission)))
    return <Notice>{t('gameUi.noPermission')}</Notice>;
  return (
    <>
      {operation.error && (
        <ErrorNotice error={operation.error} retry={() => void operation.refetch()} />
      )}
      {loaded.data.metadata?.installed === false && <Notice>{t('gameUi.profileNotReady')}</Notice>}
      {section.columns.length > 0 && (
        <Section title={t(section.titleKey)}>
          {loaded.data.rows.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {section.columns.map((column) => (
                      <th key={column.id}>{t(column.labelKey)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loaded.data.rows.map((row, index) => (
                    <tr key={`${String(row.id ?? row.path ?? row.name ?? index)}`}>
                      {section.columns.map((column) => (
                        <td key={column.id}>
                          {column.format === 'date' && typeof row[column.id] === 'string' ? (
                            <Time value={row[column.id] as string} />
                          ) : column.format === 'message' && typeof row[column.id] === 'string' ? (
                            t(String(row[column.id]))
                          ) : (
                            String(row[column.id] ?? '—')
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty text={t('gameUi.noRows')} />
          )}
        </Section>
      )}
      {section.forms.map((form) => {
        const capability = form.action?.requiredCapabilities.every(
          (cap) =>
            server.data.capabilities?.[
              cap as keyof NonNullable<typeof server.data.capabilities>
            ] === true,
        );
        const profileCapability = form.action?.requiredCapabilities.every(
          (cap) => loaded.data.metadata?.[cap] !== false,
        );
        if (capability === false || profileCapability === false) return null;
        return (
          <GameActionForm
            key={`${serverId}-${form.id}`}
            {...{ module, form, serverId }}
            data={loaded.data}
            canManage={
              form.action?.requiredPermissions.every((p) => permissions.includes(p)) ?? false
            }
            state={server.data.runtimeState}
            activeOperation={pendingOperation || Boolean(server.data.activeOperationId)}
            refreshToken={refreshToken}
            completedOperationId={completedOperationId}
            onAccepted={(jobId) => {
              setOperationId(jobId);
              void loaded.refetch();
              void server.refetch();
            }}
          />
        );
      })}
    </>
  );
}
function GameActionForm({
  module,
  form,
  serverId,
  data,
  canManage,
  state,
  activeOperation,
  onAccepted,
  refreshToken,
  completedOperationId,
}: {
  module: TrustedGameUiModule;
  form: UiForm;
  serverId: string;
  data: UiSectionData;
  canManage: boolean;
  state: string;
  activeOperation: boolean;
  onAccepted: (jobId: string) => void;
  refreshToken: number;
  completedOperationId?: string;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, unknown>>({ ...data.values }),
    [choices, setChoices] = useState<Record<string, UiOption[]>>({}),
    [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [job, setJob] = useState<string>();
  const key = useRef(idempotencyKey()),
    summary = useRef<HTMLDivElement>(null);
  const dirty = useRef(new Map<string, number>());
  const editRevision = useRef(0);
  const submitted = useRef<{ jobId: string; revision: number } | undefined>(undefined);
  const synchronizedJob = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (completedOperationId && completedOperationId === job && synchronizedJob.current !== job) {
      if (submitted.current?.jobId === job) {
        for (const [name, revision] of dirty.current)
          if (revision <= submitted.current.revision) dirty.current.delete(name);
      }
      synchronizedJob.current = job;
    }
    setValues((previous) => ({
      ...data.values,
      ...Object.fromEntries([...dirty.current.keys()].map((name) => [name, previous[name]])),
    }));
  }, [data.values, completedOperationId, job]);
  const fields = data.editableFields
    ? form.fields.filter((f) => data.editableFields?.includes(f.id))
    : form.fields;
  const blocked =
    !canManage || activeOperation || (form.action?.requiresStopped && state !== 'offline');
  const context: GameUiContext = {
    serverId,
    values: Object.fromEntries(
      fields
        .filter((f) => visibleFields(fields, values).includes(f))
        .map((f) => [f.id, values[f.id]])
        .filter(([, v]) => v !== undefined),
    ),
    idempotencyKey: key.current,
  };
  const onChange = (id: string, value: unknown) => {
    dirty.current.set(id, ++editRevision.current);
    setValues((previous) => ({ ...previous, [id]: value }));
    setErrors((previous) => ({ ...previous, [id]: '' }));
    key.current = idempotencyKey();
  };
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!form.action || blocked || busy) return;
    const invalid = validateUiValues(fields, values, choices);
    setErrors(Object.fromEntries(invalid.map((e) => [e.field, e.code])));
    if (invalid.length) {
      setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    if (form.action.destructive && !confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setFailure(undefined);
    const submittedRevision = editRevision.current;
    try {
      const result = z
        .object({ jobId: z.uuid() })
        .passthrough()
        .parse(await module.handlers[form.action.handler]?.(gameUiClient, context));
      setJob(result.jobId);
      submitted.current = { jobId: result.jobId, revision: submittedRevision };
      key.current = idempotencyKey();
      setConfirm(false);
      onAccepted(result.jobId);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title={t(form.titleKey)}>
      {fields.length === 0 && form.fields.length > 0 ? (
        <Empty text={t('gameUi.noFields')} />
      ) : (
        <form className="form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
          {!canManage ? (
            <Notice>{t('gameUi.noPermission')}</Notice>
          ) : activeOperation ? (
            <Notice>{t('gameUi.operationBusy')}</Notice>
          ) : form.action?.requiresStopped && state !== 'offline' ? (
            <Notice>{t('gameUi.stopFirst')}</Notice>
          ) : null}
          {Object.values(errors).some(Boolean) && (
            <div ref={summary} role="alert" tabIndex={-1}>
              <p>{t('gameUi.required')}</p>
            </div>
          )}
          {failure !== undefined && <ErrorNotice error={failure} />}
          <fieldset disabled={Boolean(blocked) || busy}>
            <GameFields
              {...{ module, fields, values, onChange, serverId, errors, refreshToken }}
              onChoices={(id, options) =>
                setChoices((previous) => ({ ...previous, [id]: options }))
              }
            />
          </fieldset>
          {form.action && (
            <div className="form-footer">
              <button
                className={form.action.destructive ? 'danger' : undefined}
                type="submit"
                disabled={Boolean(blocked) || busy}
              >
                {t(form.action.labelKey)}
              </button>
            </div>
          )}
        </form>
      )}
      <JobNotice jobId={job} />
      <Dialog
        open={confirm}
        title={t('gameUi.confirmAction')}
        onClose={() => {
          if (!busy) setConfirm(false);
        }}
      >
        <div className="stack">
          <p>{form.action?.confirmationKey && t(form.action.confirmationKey)}</p>
          <button className="danger" type="button" disabled={busy} onClick={() => void submit()}>
            {form.action && t(form.action.labelKey)}
          </button>
        </div>
      </Dialog>
    </Section>
  );
}

function ArchiveCatalog({
  module,
  field,
  serverId,
  disabled,
  onSelected,
}: {
  module: TrustedGameUiModule;
  field: Extract<UiField, { type: 'archive' }>;
  serverId?: string;
  disabled: boolean;
  onSelected: (id: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState(''),
    [hits, setHits] = useState<{ projectId: string; title: string; description: string }[]>(),
    [projectId, setProjectId] = useState(''),
    [versions, setVersions] = useState<{ versionId: string; name: string; version: string }[]>([]),
    [versionId, setVersionId] = useState(''),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<unknown>();
  const abort = useRef<AbortController | undefined>(undefined),
    key = useRef(idempotencyKey());
  useEffect(() => () => abort.current?.abort(), []);
  async function search() {
    if (!field.catalog) return;
    setBusy(true);
    setFailure(undefined);
    setProjectId('');
    setVersionId('');
    setVersions([]);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const data = z
        .object({
          hits: z.array(
            z.object({ projectId: z.string(), title: z.string(), description: z.string() }),
          ),
        })
        .parse(
          await module.handlers[field.catalog.searchHandler]?.(gameUiClient, {
            serverId,
            values: { query },
            signal: controller.signal,
          }),
        );
      setHits(data.hits);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  async function choose(project: string) {
    if (!field.catalog) return;
    setProjectId(project);
    setVersionId('');
    setVersions([]);
    setBusy(true);
    setFailure(undefined);
    key.current = idempotencyKey();
    try {
      setVersions(
        z.array(z.object({ versionId: z.string(), name: z.string(), version: z.string() })).parse(
          await module.handlers[field.catalog.versionsHandler]?.(gameUiClient, {
            serverId,
            values: { projectId: project },
          }),
        ),
      );
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  async function acquire() {
    if (!field.catalog || !projectId || !versionId) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const source = z.object({ id: z.string().uuid(), state: z.literal('ready') }).parse(
        await module.handlers[field.catalog.acquireHandler]?.(gameUiClient, {
          serverId,
          idempotencyKey: key.current,
          values: { projectId, versionId },
        }),
      );
      onSelected(source.id);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>{t('gameUi.providerSearch')}</summary>
      <div className="stack">
        <Input
          label={t('gameUi.search')}
          value={query}
          maxLength={256}
          disabled={disabled || busy}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="secondary"
          disabled={disabled || busy}
          onClick={() => void search()}
        >
          {t('gameUi.search')}
        </button>
        {failure !== undefined && <ErrorNotice error={failure} />} {busy && <Loading />}
        {hits?.length === 0 && <Empty />}
        {hits && hits.length > 0 && (
          <Select
            label={t('gameUi.providerSearch')}
            disabled={disabled || busy}
            value={projectId}
            onChange={(event) => void choose(event.target.value)}
          >
            <option value="">{t('gameUi.select')}</option>
            {hits.map((hit) => (
              <option value={hit.projectId} key={hit.projectId}>
                {hit.title}
              </option>
            ))}
          </Select>
        )}
        {projectId && (
          <Select
            label={t('gameUi.packVersion')}
            value={versionId}
            disabled={disabled || busy}
            onChange={(event) => {
              setVersionId(event.target.value);
              key.current = idempotencyKey();
            }}
          >
            <option value="">{versions.length ? t('gameUi.select') : t('gameUi.noOptions')}</option>
            {versions.map((version) => (
              <option key={version.versionId} value={version.versionId}>
                {version.name}
              </option>
            ))}
          </Select>
        )}
        {versionId && (
          <button
            type="button"
            className="secondary"
            disabled={disabled || busy}
            onClick={() => void acquire()}
          >
            {t('gameUi.selectPack')}
          </button>
        )}
      </div>
    </details>
  );
}

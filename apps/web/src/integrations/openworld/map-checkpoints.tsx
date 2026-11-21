import { type FormEvent, useRef, useState } from 'react';
import type { OpenworldCheckpoint } from '../../../../../games/openworld/src/world-map.js';
import { ApiError, api } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Dialog, ErrorNotice, Input, Select, Textarea } from '../../components/ui.js';
import { mapKey as k, mapBase } from './map-query.js';

export type MapCheckpoint = OpenworldCheckpoint & { revision: string };
export type MapPoint = { face: number; x: number; z: number; y?: number };
export type CheckpointForm =
  | { kind: 'create'; point?: MapPoint }
  | { kind: 'update' | 'delete'; checkpoint: MapCheckpoint };

export function CheckpointDialog({
  form,
  world,
  edge,
  serverId,
  processRef,
  onClose,
  onSaved,
}: {
  form: CheckpointForm;
  world: string;
  edge: number;
  serverId: string;
  processRef: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const cp = form.kind === 'create' ? null : form.checkpoint;
  const initialFace = form.kind === 'create' ? form.point : undefined;
  const [location, setLocation] = useState(initialFace ? 'face' : 'geo');
  const [move, setMove] = useState(form.kind === 'create');
  const [busy, setBusy] = useState(false),
    sending = useRef(false);
  const [error, setError] = useState<unknown>();
  const uncertain =
    error instanceof ApiError &&
    (error.code === 'operation_uncertain' || [403, 401, 404, 409].includes(error.status));
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sending.current || uncertain) return;
    const data = new FormData(e.currentTarget);
    const value = (key: string) => String(data.get(key) ?? '').trim();
    const optional = (key: string) => (value(key) === '' ? null : Number(value(key)));
    if (form.kind !== 'delete' && !value('name')) {
      const input = e.currentTarget.elements.namedItem('name') as HTMLInputElement;
      input.setCustomValidity(t(k('nameRequired')));
      input.reportValidity();
      return;
    }
    if (form.kind !== 'delete') {
      const encoder = new TextEncoder();
      for (const [key, limit] of [
        ['name', 64],
        ['note', 500],
      ] as const) {
        if (encoder.encode(value(key)).length > limit) {
          const input = e.currentTarget.elements.namedItem(key) as
            | HTMLInputElement
            | HTMLTextAreaElement;
          input.setCustomValidity(t(k('byteLimit'), { limit }));
          input.reportValidity();
          return;
        }
      }
    }
    const fields = {
      name: value('name'),
      note: value('note'),
      color: value('color'),
      icon: value('icon'),
      visibility: value('visibility'),
    };
    const position =
      location === 'geo'
        ? {
            type: 'geo',
            lat: Number(value('lat')),
            lon: Number(value('lon')),
            alt: optional('alt'),
          }
        : {
            type: 'face',
            face: Number(value('face')),
            x: Number(value('x')),
            z: Number(value('z')),
            y: optional('y'),
          };
    const action =
      form.kind === 'delete'
        ? { kind: 'delete', id: form.checkpoint.id, revision: form.checkpoint.revision }
        : {
            kind: form.kind,
            ...(form.kind === 'update'
              ? { id: form.checkpoint.id, revision: form.checkpoint.revision }
              : {}),
            fields,
            ...(move ? { position } : {}),
          };
    sending.current = true;
    setBusy(true);
    setError(undefined);
    const requestId = crypto.randomUUID();
    try {
      const receipt = await api<{ outcome: string; requestId: string }>(
        `${mapBase(serverId)}/checkpoints`,
        { body: { world, processRef, action, requestId } },
      );
      if (receipt.outcome !== 'accepted' || receipt.requestId !== requestId)
        throw Error('missing_receipt');
      onSaved();
    } catch (e) {
      setError(
        e instanceof ApiError && !(e.code === 'internal_error' && e.status >= 500)
          ? e
          : new ApiError(
              'operation_uncertain',
              'errors.operation_uncertain',
              e instanceof ApiError ? e.requestId : undefined,
            ),
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const title = t(k(form.kind === 'update' ? 'edit' : form.kind === 'delete' ? 'delete' : 'new'));
  return (
    <Dialog
      open
      title={title}
      closeIcon
      closeDisabled={busy}
      className="ow-detail ow-map-dialog"
      onClose={() => {
        if (!sending.current) onClose();
      }}
      initialFocusSelector={form.kind === 'delete' ? '[data-cancel]' : '[name="name"]'}
    >
      <form onSubmit={submit} aria-busy={busy}>
        {error ? <ErrorNotice error={error} /> : null}
        {form.kind === 'delete' ? (
          <p>{t(k('deletePrompt'), { name: form.checkpoint.name, world })}</p>
        ) : (
          <fieldset disabled={busy || uncertain} className="ow-map-fields">
            <Input
              name="name"
              label={t('web.name')}
              required
              autoComplete="off"
              defaultValue={cp?.name}
              maxLength={64}
              onInput={(e) => e.currentTarget.setCustomValidity('')}
            />
            <Textarea
              name="note"
              label={t(k('note'))}
              rows={2}
              maxLength={500}
              onInput={(e) => e.currentTarget.setCustomValidity('')}
              defaultValue={cp?.note}
            />
            <div className="ow-map-inputs">
              <Select
                name="visibility"
                label={t(k('visibility'))}
                defaultValue={cp?.visibility ?? 'admins'}
              >
                <option value="admins">{t(k('admins'))}</option>
                <option value="players">{t(k('players'))}</option>
              </Select>
              <Select name="icon" label={t(k('icon'))} defaultValue={cp?.icon ?? 'flag'}>
                {['flag', 'star', 'home', 'skull', 'gem', 'pin'].map((icon) => (
                  <option key={icon} value={icon}>
                    {t(k(`icon.${icon}`))}
                  </option>
                ))}
              </Select>
              <Input
                name="color"
                type="color"
                label={t(k('color'))}
                defaultValue={cp?.color ?? '#32845e'}
              />
            </div>
            {cp && (
              <label className="check">
                <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} />
                {t(k('move'))}
              </label>
            )}
            {move && (
              <div className="ow-map-coordinates">
                <Select
                  label={t(k('position'))}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                >
                  <option value="geo">{t(k('geographic'))}</option>
                  <option value="face">{t(k('onFace'))}</option>
                </Select>
                <div key={location} className="ow-map-inputs">
                  {location === 'geo' ? (
                    <>
                      <Input
                        name="lat"
                        label={t('games.openworld.telemetry.latitude')}
                        type="number"
                        step="any"
                        min={-90}
                        max={90}
                        required
                        defaultValue={cp?.geo.lat}
                      />
                      <Input
                        name="lon"
                        label={t('games.openworld.telemetry.longitude')}
                        type="number"
                        step="any"
                        min={-180}
                        max={180}
                        required
                        defaultValue={cp?.geo.lon}
                      />
                      <Input
                        name="alt"
                        label={t(k('altitude'))}
                        type="number"
                        step="any"
                        defaultValue={cp?.geo.alt}
                      />
                    </>
                  ) : (
                    <>
                      <Select
                        name="face"
                        label={t(k('face'))}
                        defaultValue={initialFace?.face ?? cp?.pos.face ?? 0}
                      >
                        {faces.map((i) => (
                          <option key={i} value={i}>
                            {i}
                          </option>
                        ))}
                      </Select>
                      <Input
                        name="x"
                        label="X (m)"
                        type="number"
                        min={0}
                        max={edge}
                        required
                        step="any"
                        defaultValue={initialFace?.x ?? cp?.pos.x}
                      />
                      <Input
                        name="z"
                        label="Z (m)"
                        type="number"
                        min={0}
                        max={edge}
                        required
                        step="any"
                        defaultValue={initialFace?.z ?? cp?.pos.z}
                      />
                      <Input
                        name="y"
                        label={t(k('altitude'))}
                        type="number"
                        step="any"
                        defaultValue={initialFace?.y ?? cp?.pos.y}
                      />
                    </>
                  )}
                </div>
              </div>
            )}
          </fieldset>
        )}
        <footer className="dialog-actions">
          <button data-cancel type="button" className="secondary" disabled={busy} onClick={onClose}>
            {t('web.cancel')}
          </button>
          <button
            type="submit"
            className={form.kind === 'delete' ? 'danger' : undefined}
            disabled={busy || uncertain}
          >
            {busy ? t('web.pending') : form.kind === 'update' ? t('web.save') : t(k(form.kind))}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
export const faces = [0, 1, 2, 3, 4, 5];

const glyphs = {
  flag: 'M5 21V3m0 1c5-3 8 3 14 0v10c-6 3-9-3-14 0',
  star: 'm12 3 2.9 5.8 6.4.9-4.6 4.5 1.1 6.4-5.8-3-5.8 3 1.1-6.4-4.6-4.5 6.4-.9Z',
  home: 'm3 11 9-8 9 8M6 10v11h12V10m-8 11v-7h4v7',
  skull: 'M7 16a8 8 0 1 1 10 0v4h-3v-2h-4v2H7Zm0-5h3m4 0h3m-6 4 1-2 1 2',
  gem: 'm2 9 5-6h10l5 6-10 12Zm0 0h20M9 4 7 9l5 12 5-12-2-5',
  pin: 'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Zm-5 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
};
export function CheckpointGlyph({ icon }: { icon: MapCheckpoint['icon'] }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={glyphs[icon]} />
    </svg>
  );
}

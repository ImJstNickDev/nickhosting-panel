import { type PointerEvent, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api, apiError, queryClient } from '../api/client.js';
import { useLocale, useT } from '../app/i18n.js';
import type { WebSession } from '../app/session.js';
import { ProfileAvatar } from '../components/profile-avatar.js';
import { Tooltip } from '../components/tooltip.js';
import { Dialog, ErrorNotice } from '../components/ui.js';
import { AccountIcon } from './account-icons.js';
import {
  constrainPhotoCrop,
  initialPhotoCrop,
  type PhotoCrop,
  photoCropRect,
} from './profile-photo-crop.js';
import './profile-photo.css';

interface PhotoDraft {
  url: string;
  image: HTMLImageElement;
}

async function validatePhoto(file: File) {
  if (file.size > 5 * 1024 * 1024) throw new ApiError('photo_size', 'web.photoSizeError');
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (
    !(
      (png && (!file.type || file.type === 'image/png')) ||
      (jpeg && (!file.type || file.type === 'image/jpeg')) ||
      (webp && (!file.type || file.type === 'image/webp'))
    )
  )
    throw new ApiError('photo_format', 'web.photoFormatError');
}

function renderPhoto(draft: PhotoDraft, crop: PhotoCrop): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new ApiError('photo_prepare', 'web.photoSaveError'));
  const rect = photoCropRect(draft.image.naturalWidth, draft.image.naturalHeight, crop);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(draft.image, rect.x, rect.y, rect.size, rect.size, 0, 0, 256, 256);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob && blob.size <= 300 * 1024) resolve(blob);
      else reject(new ApiError('photo_prepare', 'web.photoSaveError'));
    }, 'image/png');
  });
}

async function refreshPhoto(userId: string, avatarUrl: string | null) {
  await queryClient.cancelQueries({ queryKey: ['session'] });
  queryClient.setQueryData<WebSession>(['session'], (current) => {
    if (!current || current.subject.id !== userId || current.context.sessionType !== 'regular')
      return current;
    return {
      ...current,
      subject: { ...current.subject, avatarUrl },
      actor: current.actor.id === userId ? { ...current.actor, avatarUrl } : current.actor,
    };
  });
  await queryClient.invalidateQueries({ queryKey: ['session'] });
}

export function ProfilePhoto({
  userId,
  avatarUrl,
  displayName,
  username,
}: {
  userId: string;
  avatarUrl?: string | null;
  displayName?: string;
  username?: string;
}) {
  const t = useT();
  const { locale } = useLocale();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const urls = useRef(new Set<string>());
  const draftRef = useRef<PhotoDraft | null>(null);
  const busy = useRef(false);
  const [draft, setDraft] = useState<PhotoDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    mounted.current = true;
    const ownedUrls = urls.current;
    return () => {
      mounted.current = false;
      generation.current++;
      draftRef.current = null;
      for (const url of ownedUrls) URL.revokeObjectURL(url);
      ownedUrls.clear();
    };
  }, []);

  function discard() {
    generation.current++;
    if (draftRef.current) {
      URL.revokeObjectURL(draftRef.current.url);
      urls.current.delete(draftRef.current.url);
    }
    draftRef.current = null;
    setDraft(null);
    requestAnimationFrame(() => {
      if (mounted.current && !draftRef.current) trigger.current?.focus({ preventScroll: true });
    });
  }

  async function choose(file: File) {
    const selected = ++generation.current;
    setError(undefined);
    setStatus(undefined);
    let url: string | undefined;
    try {
      await validatePhoto(file);
      if (!mounted.current || generation.current !== selected) return;
      url = URL.createObjectURL(file);
      urls.current.add(url);
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('empty_image');
      if (!mounted.current || generation.current !== selected) {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
        return;
      }
      const next = { url, image };
      draftRef.current = next;
      setDraft(next);
    } catch (cause) {
      if (url) {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }
      if (mounted.current && generation.current === selected)
        setError(
          cause instanceof ApiError ? cause : new ApiError('photo_read', 'web.photoReadError'),
        );
    }
  }

  async function save(selected: PhotoDraft, crop: PhotoCrop) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const photo = await renderPhoto(selected, crop);
      // Leaving Settings discards drafts while the browser finishes PNG encoding.
      if (!mounted.current || draftRef.current !== selected) return;
      const response = await fetch('/v1/web/profile-photo', {
        method: 'PUT',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          'Content-Type': 'image/png',
          'Accept-Language': locale === 'it' ? 'it' : 'en',
        },
        body: photo,
      });
      if (!response.ok) throw apiError(await response.json().catch(() => ({})), response.status);
      const result = (await response.json()) as { avatarUrl: string };
      await refreshPhoto(userId, result.avatarUrl);
      if (mounted.current) {
        if (draftRef.current === selected) discard();
        setStatus('web.photoSaved');
      }
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  async function remove() {
    if (busy.current) return;
    const previousFocus = document.activeElement;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setStatus(undefined);
    try {
      await api('/v1/web/profile-photo', { method: 'DELETE' });
      await refreshPhoto(userId, null);
      if (mounted.current) {
        setStatus('web.photoRemoved');
        requestAnimationFrame(() => {
          if (
            mounted.current &&
            !draftRef.current &&
            (document.activeElement === previousFocus || document.activeElement === document.body)
          )
            trigger.current?.focus({ preventScroll: true });
        });
      }
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <div className="profile-photo-control">
      <div className="profile-photo-row" aria-busy={pending}>
        <span className="profile-photo-avatar">
          <ProfileAvatar avatarUrl={avatarUrl} />
        </span>
        <div className="profile-photo-details">
          <h3 className="profile-photo-name">{displayName ?? t('web.profilePhoto')}</h3>
          {username && (
            <p className="profile-photo-username">
              <span className="visually-hidden">{t('web.username')}: </span>@{username}
            </p>
          )}
          <small id={`${id}-formats`} className="visually-hidden">
            {t('web.profilePhotoFormats')}
          </small>
        </div>
        <div className="profile-photo-actions">
          <Tooltip content={t('web.profilePhotoFormats')}>
            <button
              ref={trigger}
              type="button"
              className="account-quiet-action"
              disabled={pending}
              aria-describedby={`${id}-formats`}
              onClick={() => input.current?.click()}
            >
              <AccountIcon name="camera" />
              {t('web.changePhoto')}
            </button>
          </Tooltip>
          {avatarUrl && (
            <Tooltip content={t('web.removePhoto')}>
              <button
                type="button"
                className="account-icon-action profile-photo-remove"
                disabled={pending}
                aria-label={t('web.removePhoto')}
                onClick={() => void remove()}
              >
                <AccountIcon name="remove" />
              </button>
            </Tooltip>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label={t('web.changePhoto')}
          disabled={pending}
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void choose(file);
          }}
        />
      </div>
      {!draft && Boolean(error) && <ErrorNotice error={error} />}
      <div className="profile-photo-feedback">
        {!draft && pending && (
          <p className="profile-photo-status" role="status">
            {t('web.pending')}
          </p>
        )}
        {!pending && status && (
          <p className="profile-photo-status" role="status">
            {t(status)}
          </p>
        )}
      </div>
      {draft &&
        createPortal(
          <PhotoCropDialog
            key={draft.url}
            draft={draft}
            pending={pending}
            error={error}
            onClose={() => {
              if (!busy.current) discard();
            }}
            onSave={(crop) => void save(draft, crop)}
          />,
          document.body,
        )}
    </div>
  );
}

function PhotoCropDialog({
  draft,
  pending,
  error,
  onClose,
  onSave,
}: {
  draft: PhotoDraft;
  pending: boolean;
  error: unknown;
  onClose(): void;
  onSave(crop: PhotoCrop): void;
}) {
  const t = useT();
  const id = useId();
  const [crop, setCrop] = useState(initialPhotoCrop);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const width = draft.image.naturalWidth;
  const height = draft.image.naturalHeight;
  const rect = photoCropRect(width, height, crop);

  function move(event: PointerEvent<HTMLButtonElement>) {
    const previous = drag.current;
    if (pending || !previous || event.pointerId !== previous.id) return;
    const scale = rect.size / event.currentTarget.getBoundingClientRect().width;
    const dx = (event.clientX - previous.x) * scale;
    const dy = (event.clientY - previous.y) * scale;
    drag.current = { id: previous.id, x: event.clientX, y: event.clientY };
    setCrop((current) =>
      constrainPhotoCrop(width, height, {
        ...current,
        x: current.x + dx,
        y: current.y + dy,
      }),
    );
  }

  return (
    <Dialog
      open
      title={t('web.adjustPhoto')}
      onClose={onClose}
      showClose={false}
      className="profile-photo-dialog"
      initialFocusSelector="[data-photo-crop]"
    >
      <div className="profile-photo-editor">
        <button
          type="button"
          className="profile-photo-crop"
          disabled={pending}
          data-photo-crop
          aria-label={t('web.photoPosition')}
          aria-describedby={`${id}-position`}
          onPointerDown={(event) => {
            if (pending || event.button !== 0 || !event.isPrimary) return;
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          }}
          onPointerMove={move}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const step = rect.size * (event.shiftKey ? 0.1 : 0.025);
            const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
            const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
            setCrop((current) =>
              constrainPhotoCrop(width, height, {
                ...current,
                x: current.x + dx,
                y: current.y + dy,
              }),
            );
          }}
        >
          <img
            src={draft.url}
            alt=""
            draggable={false}
            style={{
              width: `${(width / rect.size) * 100}%`,
              height: `${(height / rect.size) * 100}%`,
              left: `${(-rect.x / rect.size) * 100}%`,
              top: `${(-rect.y / rect.size) * 100}%`,
            }}
          />
        </button>
        <p className="profile-photo-hint" id={`${id}-position`}>
          {t('web.photoPositionHint')}
        </p>
        <div className="profile-photo-zoom">
          <label htmlFor={`${id}-zoom`}>{t('web.photoZoom')}</label>
          <input
            id={`${id}-zoom`}
            type="range"
            min="1"
            max="4"
            step="0.05"
            disabled={pending}
            value={crop.zoom}
            aria-valuetext={t('web.photoZoomValue', { value: Math.round(crop.zoom * 100) })}
            onChange={(event) =>
              setCrop((current) =>
                constrainPhotoCrop(width, height, {
                  ...current,
                  zoom: Number(event.target.value),
                }),
              )
            }
          />
        </div>
        {Boolean(error) && <ErrorNotice error={error} />}
        <div className="profile-photo-dialog-actions">
          <button type="button" className="secondary" disabled={pending} onClick={onClose}>
            {t('web.cancel')}
          </button>
          <button type="button" disabled={pending} onClick={() => onSave({ ...crop })}>
            {t(pending ? 'web.pending' : 'web.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

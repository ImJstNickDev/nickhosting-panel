import { useEffect, useState } from 'react';
import { useT } from '../../app/i18n.js';
import type { ActionReceipt } from './player-actions.js';
import { key } from './telemetry.js';

export function PlayerActionToast({
  receipt,
  onDismiss,
  onOpenGallery,
}: {
  receipt: ActionReceipt | null;
  onDismiss: () => void;
  onOpenGallery?: () => void;
}) {
  const t = useT();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const screenshot = receipt?.kind === 'screenshot';

  useEffect(() => {
    if (!receipt) {
      setHovered(false);
      setFocused(false);
      return;
    }
    if (hovered || focused) return;
    const timer = window.setTimeout(onDismiss, screenshot ? 10000 : 6000);
    return () => window.clearTimeout(timer);
  }, [receipt, hovered, focused, screenshot, onDismiss]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Pointer and focus events only pause dismissal while the notification is in use.
    <div
      className={receipt ? 'ow-action-toast' : 'visually-hidden'}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {receipt && (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <path d="m7.5 12 3 3 6-6" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      )}
      <span role="status" aria-atomic="true">
        {receipt && (
          <span key={receipt.requestId}>
            {t(key(screenshot ? 'screenshotRequested' : 'actionAccepted'), {
              name: receipt.playerName,
              action: t(key(`action.${receipt.kind}`)),
            })}
          </span>
        )}
      </span>
      {screenshot && onOpenGallery && (
        <button
          className="ow-action-toast-gallery"
          type="button"
          onClick={() => {
            onDismiss();
            onOpenGallery();
          }}
        >
          {t(key('openGallery'))}
        </button>
      )}
      {receipt && (
        <button
          className="ow-action-toast-close"
          type="button"
          aria-label={t('web.close')}
          onClick={onDismiss}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      )}
    </div>
  );
}

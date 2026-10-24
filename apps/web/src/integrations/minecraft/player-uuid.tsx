import { useEffect, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';

export function PlayerUuid({ uuid }: { uuid: string }) {
  // A different player must never inherit the previous player's copy receipt.
  return <UuidCopy key={uuid} uuid={uuid} />;
}

function UuidCopy({ uuid }: { uuid: string }) {
  const t = useT();
  const [feedback, setFeedback] = useState<'copied' | 'failed' | undefined>();
  useEffect(() => {
    if (feedback !== 'copied') return;
    const timeout = setTimeout(() => setFeedback(undefined), 2000);
    return () => clearTimeout(timeout);
  }, [feedback]);
  const label = t('games.minecraft.players.copyUuid');
  return (
    <span className="minecraft-player-uuid">
      <code>{uuid}</code>
      <Tooltip content={feedback === 'copied' ? t('web.copied') : label}>
        <button
          type="button"
          className="minecraft-player-uuid-copy"
          aria-label={label}
          onClick={async () => {
            setFeedback(undefined);
            try {
              await navigator.clipboard.writeText(uuid);
              setFeedback('copied');
            } catch {
              setFeedback('failed');
            }
          }}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
          >
            <path
              d={feedback === 'copied' ? 'm5 12 4 4L19 6' : 'M9 8h11v13H9z M5 16H3V3h11v2'}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </Tooltip>
      <span className="visually-hidden" role="status">
        {feedback === 'copied' ? t('web.copied') : ''}
      </span>
      {feedback === 'failed' && (
        <span className="minecraft-player-uuid-error" role="alert">
          {t('games.minecraft.players.copyUuidFailed')}
        </span>
      )}
    </span>
  );
}

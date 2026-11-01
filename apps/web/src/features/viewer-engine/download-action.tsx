import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { download } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { FilemanToolbarIcon } from '../fileman/presentation.js';

export function ViewerDownload({ original, decoded }: { original: string; decoded?: string }) {
  const t = useT();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector('button')?.focus();
    function outside(event: PointerEvent) {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setPosition(undefined);
    }
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [position]);
  function close() {
    setPosition(undefined);
    trigger.current?.focus();
  }
  return (
    <>
      <Tooltip placement="cursor" content={position ? '' : t('web.download')}>
        <button
          ref={trigger}
          type="button"
          className="fm-tool"
          aria-label={t('web.download')}
          aria-haspopup={decoded ? 'menu' : undefined}
          aria-expanded={decoded ? Boolean(position) : undefined}
          onClick={() => {
            if (!decoded) return download(original);
            if (position) return close();
            const rect = trigger.current?.getBoundingClientRect();
            if (rect)
              setPosition({
                left: Math.max(8, Math.min(rect.left, window.innerWidth - 228)),
                top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 100)),
              });
          }}
        >
          <FilemanToolbarIcon kind="download" />
        </button>
      </Tooltip>
      {position &&
        decoded &&
        createPortal(
          <div
            ref={menu}
            role="menu"
            aria-label={t('web.download')}
            className="fm-menu ve-archive-menu"
            style={position}
            onKeyDown={(event) => {
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
              ];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                buttons[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? buttons.length - 1
                      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) %
                        buttons.length
                ]?.focus();
              }
              if (event.key === 'Escape' || event.key === 'Tab') {
                if (event.key === 'Escape') event.preventDefault();
                close();
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                download(original);
                close();
              }}
            >
              {t('viewer.downloadArchive')}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                download(decoded);
                close();
              }}
            >
              {t('viewer.downloadFile')}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

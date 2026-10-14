import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../../../app/i18n.js';
import { Tooltip } from '../../../../components/tooltip.js';
import { QuillButton } from './ui-controls.js';

/** Native light-dismiss surface: Escape closes these options, not Fileman. */
export function QuillPrintControl({
  active,
  disabled,
  onPrint,
}: {
  active: boolean;
  disabled: boolean;
  onPrint(scale: number): void;
}) {
  const t = useT();
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState('100');
  const numeric = Number(scale);
  useEffect(() => {
    if (!active || disabled) popup.current?.hidePopover();
  }, [active, disabled]);
  function step(delta: number) {
    setScale(
      String(
        Math.min(200, Math.max(25, (Number.isFinite(numeric) && scale ? numeric : 100) + delta)),
      ),
    );
  }
  function print() {
    if (!input.current?.reportValidity()) return;
    popup.current?.hidePopover();
    onPrint(numeric);
  }
  return (
    <span ref={anchor} className="quill-print-control">
      <QuillButton
        kind="print"
        label={t('quill.print')}
        disabled={disabled}
        popoverTarget={id}
        expanded={open}
        onClick={() => {
          const rect = anchor.current?.getBoundingClientRect();
          const node = popup.current;
          if (!rect || !node) return;
          node.style.left = `${Math.max(8, Math.min(rect.right - 248, window.innerWidth - 256))}px`;
          node.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 150))}px`;
        }}
      />
      {createPortal(
        <div
          ref={popup}
          id={id}
          popover="auto"
          role="dialog"
          aria-label={t('quill.print')}
          className="quill-print-options"
          onToggle={(event) => {
            const visible = event.newState === 'open';
            setOpen(visible);
            if (visible) {
              input.current?.focus({ preventScroll: true });
              input.current?.select();
            }
          }}
        >
          <div className="quill-print-fields">
            <div className="quill-print-scale-row">
              <label htmlFor={`${id}-scale`}>{t('quill.printScale')}</label>
              <div className="quill-print-scale">
                <Tooltip content={t('quill.printSmaller')}>
                  <button
                    type="button"
                    aria-label={t('quill.printSmaller')}
                    disabled={numeric <= 25 && scale !== ''}
                    onClick={() => step(-10)}
                  >
                    −
                  </button>
                </Tooltip>
                <span>
                  <input
                    ref={input}
                    id={`${id}-scale`}
                    type="number"
                    min={25}
                    max={200}
                    step={1}
                    required
                    value={scale}
                    onChange={(event) => setScale(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      event.stopPropagation();
                      print();
                    }}
                  />
                  <span aria-hidden="true">%</span>
                </span>
                <Tooltip content={t('quill.printLarger')}>
                  <button
                    type="button"
                    aria-label={t('quill.printLarger')}
                    disabled={numeric >= 200}
                    onClick={() => step(10)}
                  >
                    +
                  </button>
                </Tooltip>
              </div>
            </div>
            <button type="button" className="quill-print-submit" onClick={print}>
              {t('quill.print')}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

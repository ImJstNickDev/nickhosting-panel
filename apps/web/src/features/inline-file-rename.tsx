import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../app/i18n.js';
import { ErrorNotice } from '../components/ui.js';
import { filenameSelection, validFilename } from './inline-file-rename-model.js';
import './inline-file-rename.css';

interface InlineFileRenameProps {
  name: string;
  onCommit(name: string): Promise<void>;
  onCancel(): void;
  onComplete?(): void;
}

/** Enter and blur share one submission; neither validation nor completion traps focus. */
export function InlineFileRename({ name, onCommit, onCancel, onComplete }: InlineFileRenameProps) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const initialName = useRef(name);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const attempted = useRef<string | undefined>(undefined);
  const completed = useRef(false);
  const [value, setValue] = useState(name);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [errorPosition, setErrorPosition] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
    above: boolean;
  }>();
  const hasError = invalid || Boolean(error);

  useLayoutEffect(() => {
    mounted.current = true;
    input.current?.focus();
    input.current?.setSelectionRange(...filenameSelection(initialName.current));
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!hasError) return;
    const update = () => {
      if (!input.current) return;
      const anchor = input.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? document.documentElement.clientWidth;
      const height = viewport?.height ?? window.innerHeight;
      const below = top + height - anchor.bottom - 14;
      const above = anchor.top - top - 14;
      const showAbove = below < 100 && above > below;
      const popupWidth = Math.max(1, Math.min(320, width - 16));
      setErrorPosition({
        left: Math.max(left + 8, Math.min(anchor.left, left + width - popupWidth - 8)),
        top: showAbove ? anchor.top - 6 : anchor.bottom + 6,
        width: popupWidth,
        maxHeight: Math.max(16, Math.min(160, showAbove ? above : below)),
        above: showAbove,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (input.current) observer.observe(input.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [hasError]);

  async function commit(reason: 'enter' | 'blur') {
    if (submitting.current || completed.current) return;
    // Blurring after a failed Enter must not silently retry the same external mutation.
    if (reason === 'blur' && attempted.current === value) return;
    if (!validFilename(value)) {
      setInvalid(true);
      setError(undefined);
      return;
    }
    if (value === name) {
      completed.current = true;
      onCancel();
      return;
    }
    submitting.current = true;
    attempted.current = value;
    setPending(true);
    setInvalid(false);
    setError(undefined);
    try {
      await onCommit(value);
      completed.current = true;
      if (mounted.current) onComplete?.();
    } catch (error) {
      if (mounted.current) setError(error);
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  }

  return (
    <div className="fm-inline-rename" aria-busy={pending}>
      <div className="fm-inline-rename-field">
        <span className="fm-inline-rename-sizer" aria-hidden="true">
          {value || ' '}
        </span>
        <input
          ref={input}
          type="text"
          aria-label={t('web.name')}
          aria-invalid={invalid}
          aria-describedby={hasError ? `${id}-error` : undefined}
          value={value}
          readOnly={pending}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
          onChange={(event) => {
            setValue(event.target.value);
            attempted.current = undefined;
            setInvalid(false);
            setError(undefined);
          }}
          onBlur={() => void commit('blur')}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              void commit('enter');
            } else if (event.key === 'Escape' && !submitting.current) {
              event.preventDefault();
              event.stopPropagation();
              completed.current = true;
              onCancel();
            }
          }}
        />
      </div>
      {hasError &&
        errorPosition &&
        createPortal(
          <div
            id={`${id}-error`}
            className="fm-inline-rename-error-popup"
            style={{
              left: errorPosition.left,
              top: errorPosition.top,
              width: errorPosition.width,
              maxHeight: errorPosition.maxHeight,
              transform: errorPosition.above ? 'translateY(-100%)' : undefined,
            }}
          >
            {invalid ? (
              <span role="alert">{t('file.invalidName')}</span>
            ) : (
              <ErrorNotice error={error} />
            )}
          </div>,
          document.body,
        )}
      {pending && (
        <span className="sr-only" role="status">
          {t('web.pending')}
        </span>
      )}
    </div>
  );
}

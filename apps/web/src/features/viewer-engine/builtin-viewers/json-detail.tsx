import { useEffect, useRef, useState } from 'react';
import { useFormat, useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import type { JsonTreeClient } from './json-client.js';
import { JsonButton, JsonFeedback, JsonSkeleton } from './json-controls.js';
import type { JsonDetail } from './json-protocol.js';

const CHUNK = 16384;
export function JsonDetailPanel({
  client,
  id,
  onClose,
  onReload,
}: {
  client: JsonTreeClient;
  id: number;
  onClose: () => void;
  onReload: () => void;
}) {
  const t = useT();
  const format = useFormat();
  const [page, setPage] = useState({ id, offset: 0 });
  const offset = page.id === id ? page.offset : 0;
  const setOffset = (next: number) => setPage({ id, offset: next });
  if (page.id !== id) setPage({ id, offset: 0 });
  const [result, setResult] = useState<JsonDetail>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [copied, setCopied] = useState<'done' | 'failed'>();
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  const panel = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const change = () => setMobile(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (mobile) dialog.current?.showModal();
    else panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [mobile]);
  useEffect(() => {
    let active = true;
    setPending(true);
    setError(undefined);
    setCopied(undefined);
    void client
      .detail(id, offset, CHUNK)
      .then((value) => {
        if (active) {
          setResult(value);
          setPending(false);
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(failure);
          setPending(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, id, offset]);
  const content = (
    <>
      <div className="jt-detail-heading">
        <strong>{t('jsonTree.nodeDetails')}</strong>
        <JsonButton
          kind="close"
          label={t('jsonTree.closeDetails')}
          onClick={() => close.current()}
        />
      </div>
      {error ? (
        <JsonFeedback>
          <ErrorNotice error={error} />
          <button type="button" className="secondary" onClick={onReload}>
            {t('jsonTree.retry')}
          </button>
        </JsonFeedback>
      ) : !result || result.id !== id ? (
        <JsonSkeleton label={t('viewer.loading')} />
      ) : (
        <>
          <div className="jt-detail-meta">
            <span>{t(`jsonTree.type.${result.kind.toLowerCase()}`)}</span>
            <span>
              {t('jsonTree.location', {
                line: format.number(result.line),
                column: format.number(result.column),
              })}
            </span>
          </div>
          <code className="jt-detail-pointer">
            {result.pointer || t('jsonTree.root')}
            {result.pointerTruncated ? '…' : ''}
          </code>
          {result.pointerAmbiguous && (
            <p className="jt-detail-warning">{t('jsonTree.ambiguousPointer')}</p>
          )}
          <section
            aria-busy={pending}
            className="jt-detail-value"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded scrollable source supports keyboard selection and scrolling.
            tabIndex={0}
            aria-label={t('jsonTree.rawValue')}
          >
            {result.raw}
          </section>
          <div className="jt-detail-pager">
            <span>
              {t('jsonTree.characters', {
                start: format.number(result.totalLength ? result.offset + 1 : 0),
                end: format.number(result.offset + result.raw.length),
                total: format.number(result.totalLength),
              })}
            </span>
            <div className="jt-tools">
              <JsonButton
                kind="previous"
                label={t('jsonTree.previousChunk')}
                preserveFocus
                disabled={pending || offset === 0}
                onClick={() => setOffset(Math.max(0, result.offset - CHUNK))}
              />
              <JsonButton
                kind="next"
                label={t('jsonTree.nextChunk')}
                preserveFocus
                disabled={pending || result.offset + result.raw.length >= result.totalLength}
                onClick={() => setOffset(result.offset + result.raw.length)}
              />
              <JsonButton
                kind="copy"
                label={t('jsonTree.copyChunk')}
                preserveFocus
                disabled={pending}
                onClick={() => {
                  void Promise.resolve()
                    .then(() => navigator.clipboard.writeText(result.raw))
                    .then(() => setCopied('done'))
                    .catch(() => setCopied('failed'));
                }}
              />
            </div>
          </div>
          {copied && (
            <p className="jt-detail-status" role="status">
              {t(copied === 'done' ? 'jsonTree.copied' : 'jsonTree.copyFailed')}
            </p>
          )}
        </>
      )}
    </>
  );
  const keydown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close.current();
    }
  };
  if (mobile)
    return (
      <dialog
        ref={dialog}
        className="jt-detail jt-detail-modal"
        aria-label={t('jsonTree.nodeDetails')}
        onCancel={(event) => {
          event.preventDefault();
          close.current();
        }}
        onKeyDown={keydown}
      >
        {content}
      </dialog>
    );
  return (
    <section
      ref={panel}
      className="jt-detail"
      aria-label={t('jsonTree.nodeDetails')}
      onKeyDown={keydown}
    >
      {content}
    </section>
  );
}

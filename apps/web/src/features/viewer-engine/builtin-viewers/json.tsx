import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useFormat, useT } from '../../../app/i18n.js';
import { Tooltip } from '../../../components/tooltip.js';
import { ErrorNotice } from '../../../components/ui.js';
import { readViewerBytes, viewerPath } from '../core/access.js';
import { previewLimits } from '../core/limits.js';
import { viewerExtension } from '../core/registry.js';
import type { ViewerProps } from '../core/types.js';
import { useViewerResource } from '../core/use-resource.js';
import { JsonTreeClient } from './json-client.js';
import { JsonButton, JsonFeedback, JsonIcon, JsonSkeleton } from './json-controls.js';
import { JsonDetailPanel } from './json-detail.js';
import type { JsonAction, JsonDetail, JsonView } from './json-protocol.js';
import './json-tree.css';

const ROW_HEIGHT = 30;
const OVERSCAN = 8;

export default function JsonViewer(props: ViewerProps) {
  return (
    <JsonDocument key={JSON.stringify([props.identity, props.serverId, props.source])} {...props} />
  );
}
function JsonDocument({ serverId, source }: ViewerProps) {
  const t = useT();
  const [attempt, setAttempt] = useState(0);
  const url = viewerPath(serverId, source);
  const result = useViewerResource(
    `${url}:${attempt}`,
    async (signal) => {
      const bytes = await readViewerBytes(url, previewLimits.jsonBytes, signal);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw { messageKey: 'viewer.jsonInvalid' };
      }
      const client = new JsonTreeClient(signal);
      try {
        return { client, initial: await client.load(text, viewerExtension(source.name)) };
      } catch (error) {
        client.dispose();
        throw error;
      }
    },
    ({ client }) => client.dispose(),
  );
  if (result.error) {
    const position = result.error as { line?: number; column?: number };
    return (
      <div className="ve-json">
        <JsonFeedback>
          <ErrorNotice error={result.error} />
          {position.line !== undefined && (
            <span>
              {t('jsonTree.location', { line: position.line, column: position.column ?? 1 })}
            </span>
          )}
          <button type="button" className="secondary" onClick={() => setAttempt(attempt + 1)}>
            {t('jsonTree.retry')}
          </button>
        </JsonFeedback>
      </div>
    );
  }
  if (!result.value)
    return (
      <div className="ve-json">
        <JsonSkeleton label={t('viewer.loading')} />
      </div>
    );
  return <JsonWorkspace key={attempt} {...result.value} onReload={() => setAttempt(attempt + 1)} />;
}
function JsonWorkspace({
  client,
  initial,
  onReload,
}: {
  client: JsonTreeClient;
  initial: JsonView;
  onReload: () => void;
}) {
  const t = useT();
  const format = useFormat();
  const treeId = useId();
  const tree = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(initial);
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<unknown>();
  const [metadata, setMetadata] = useState<JsonDetail>();
  const [detail, setDetail] = useState(false);
  const [selectedId, setSelectedId] = useState(initial.selectedId);
  const mutation = useRef<Promise<JsonView>>(Promise.resolve(initial));
  const detailSequence = useRef(0);
  const revealIntent = useRef<{ mutation: Promise<JsonView>; view: JsonView } | undefined>(
    undefined,
  );
  const programmaticScroll = useRef<number | undefined>(undefined);
  const [copyStatus, setCopyStatus] = useState<'done' | 'failed'>();
  const [copying, setCopying] = useState(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  const frame = useRef(0);
  const viewport = useCallback(() => {
    const element = tree.current;
    return {
      offset: Math.max(0, Math.floor((element?.scrollTop ?? 0) / ROW_HEIGHT) - OVERSCAN),
      limit: Math.min(200, Math.ceil((element?.clientHeight ?? 600) / ROW_HEIGHT) + OVERSCAN * 2),
    };
  }, []);
  const request = useCallback(
    async (action?: JsonAction, reveal = false) => {
      const ticket = ++sequence.current;
      try {
        if (action) {
          const pending = client.action(action);
          mutation.current = pending;
          revealIntent.current = undefined;
          const changed = await pending;
          // Selection follows mutations, independently of scroll/window response ordering.
          if (!alive.current || mutation.current !== pending) return;
          setSelectedId(changed.selectedId);
          if (reveal) {
            // Commit the expanded spacer before scrolling into newly revealed descendants.
            revealIntent.current = { mutation: pending, view: changed };
            setView(changed);
            setError(undefined);
            return;
          }
        }
        const window = viewport();
        const next = await client.view(window.offset, window.limit);
        if (alive.current && ticket === sequence.current) {
          setView(next);
          setError(undefined);
        }
      } catch (failure) {
        if (alive.current && ticket === sequence.current) setError(failure);
      }
    },
    [client, viewport],
  );
  useLayoutEffect(() => {
    const intent = revealIntent.current;
    const element = tree.current;
    if (!intent || intent.view !== view || !element) return;
    revealIntent.current = undefined;
    if (intent.mutation !== mutation.current) return;
    const before = element.scrollTop;
    const top = view.selectedIndex * ROW_HEIGHT;
    if (top < before) element.scrollTop = top;
    else if (top + ROW_HEIGHT > before + element.clientHeight)
      element.scrollTop = top - element.clientHeight + ROW_HEIGHT;
    if (element.scrollTop !== before) programmaticScroll.current = element.scrollTop;
    cancelAnimationFrame(frame.current);
    void request();
  }, [view, request]);
  useEffect(() => {
    alive.current = true;
    const observer = new ResizeObserver(() => {
      void request();
    });
    if (tree.current) observer.observe(tree.current);
    void request();
    return () => {
      alive.current = false;
      sequence.current++;
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [request]);
  useEffect(() => {
    if (composing) return;
    const timeout = window.setTimeout(() => {
      void request({ type: 'search', query }, Boolean(query));
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [query, composing, request]);
  useEffect(() => {
    let current = true;
    setMetadata(undefined);
    setCopyStatus(undefined);
    void client
      .detail(selectedId, 0, 1)
      .then((value) => {
        if (current) setMetadata(value);
      })
      .catch((failure: unknown) => {
        if (current) setError(failure);
      });
    return () => {
      current = false;
    };
  }, [client, selectedId]);
  const changeBranch = async (type: 'expand' | 'collapse') => {
    try {
      const selection = await mutation.current;
      if (!alive.current) return;
      await request({ type, id: selection.selectedId });
    } catch (failure) {
      if (alive.current) setError(failure);
    }
  };
  const copy = async (kind: 'value' | 'subtree' | 'pointer') => {
    if (copying) return;
    setCopying(true);
    setCopyStatus(undefined);
    try {
      // A click or keyboard move may still be in flight when Copy is activated.
      const selection = await mutation.current;
      if (!alive.current) return;
      const text = await client.copy(selection.selectedId, kind);
      if (!alive.current) return;
      await navigator.clipboard.writeText(text);
      if (alive.current) setCopyStatus('done');
    } catch {
      if (alive.current) setCopyStatus('failed');
    } finally {
      if (alive.current) setCopying(false);
    }
  };
  const openDetail = async () => {
    const ticket = ++detailSequence.current;
    try {
      const selection = await mutation.current;
      if (!alive.current || ticket !== detailSequence.current) return;
      setSelectedId(selection.selectedId);
      setDetail(true);
    } catch (failure) {
      if (alive.current && ticket === detailSequence.current) setError(failure);
    }
  };
  const closeDetail = () => {
    detailSequence.current++;
    setDetail(false);
    requestAnimationFrame(() => tree.current?.focus());
  };
  const selected = view.rows.find((row) => row.id === view.selectedId);
  return (
    <div className="ve-json jt-workspace">
      <div className="jt-toolbar">
        <div className="jt-search">
          <JsonIcon kind="search" />
          <input
            type="search"
            aria-label={t('jsonTree.search')}
            placeholder={t('jsonTree.search')}
            value={query}
            maxLength={256}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void request({ type: 'match', direction: event.shiftKey ? -1 : 1 }, true);
              }
            }}
          />
        </div>
        {query && (
          <span className="jt-match-count" role="status">
            {view.matchCount
              ? t('jsonTree.matches', {
                  current: format.number(view.matchIndex + 1),
                  total: format.number(view.matchCount),
                })
              : t('jsonTree.noMatches')}
          </span>
        )}
        <div className="jt-tools">
          <JsonButton
            kind="previous"
            label={t('jsonTree.previousMatch')}
            disabled={!view.matchCount}
            onClick={() => {
              void request({ type: 'match', direction: -1 }, true);
            }}
          />
          <JsonButton
            kind="next"
            label={t('jsonTree.nextMatch')}
            disabled={!view.matchCount}
            onClick={() => {
              void request({ type: 'match', direction: 1 }, true);
            }}
          />
          <span className="jt-divider" />
          <JsonButton
            kind="expand"
            label={t('jsonTree.expand')}
            disabled={!selected?.childCount || selected.expanded}
            onClick={() => {
              void changeBranch('expand');
            }}
          />
          <JsonButton
            kind="collapse"
            label={t('jsonTree.collapse')}
            disabled={!selected?.childCount || !selected.expanded}
            onClick={() => {
              void changeBranch('collapse');
            }}
          />
        </div>
      </div>
      {error ? (
        <div className="jt-inline-error">
          <ErrorNotice error={error} />
          <button className="text-button" type="button" onClick={onReload}>
            {t('jsonTree.retry')}
          </button>
        </div>
      ) : null}
      <div className="jt-body">
        <div
          ref={tree}
          className="jt-tree"
          role="tree"
          aria-label={t('viewer.json')}
          aria-activedescendant={selected ? `${treeId}-${selected.id}` : undefined}
          tabIndex={0}
          onScroll={(event) => {
            const expected = programmaticScroll.current;
            programmaticScroll.current = undefined;
            if (expected !== undefined && event.currentTarget.scrollTop === expected) return;
            cancelAnimationFrame(frame.current);
            frame.current = requestAnimationFrame(() => {
              void request();
            });
          }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
              if (!window.getSelection()?.toString()) {
                event.preventDefault();
                void copy('value');
              }
              return;
            }
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            const directions = {
              ArrowDown: 'next',
              ArrowUp: 'previous',
              Home: 'first',
              End: 'last',
              ArrowLeft: 'parent',
              ArrowRight: 'child',
            } as const;
            if (event.key in directions) {
              event.preventDefault();
              void request(
                { type: 'move', direction: directions[event.key as keyof typeof directions] },
                true,
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              void openDetail();
            }
          }}
        >
          <div className="jt-spacer" style={{ height: view.totalVisible * ROW_HEIGHT }}>
            {view.rows.map((row) => (
              // biome-ignore lint/a11y/useFocusableInteractive: Tree owns focus through aria-activedescendant for virtualized rows.
              // biome-ignore lint/a11y/useKeyWithClickEvents: Tree parent handles all row keyboard actions.
              <div
                key={row.id}
                id={`${treeId}-${row.id}`}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-posinset={row.position}
                aria-setsize={row.setSize}
                aria-selected={row.selected}
                aria-expanded={row.childCount ? row.expanded : undefined}
                className="jt-row"
                data-kind={row.kind.toLowerCase()}
                data-match={row.matched || undefined}
                style={{
                  top: row.index * ROW_HEIGHT,
                  paddingLeft: `calc(min(${Math.min(row.depth, 16) * 18}px, 28%) + 8px)`,
                }}
                onClick={(event) => {
                  tree.current?.focus();
                  void request({ type: 'select', id: row.id });
                  if ((event.target as HTMLElement).closest('.jt-disclosure') && row.childCount)
                    void request({ type: 'toggle', id: row.id });
                }}
                onDoubleClick={() => {
                  void openDetail();
                }}
              >
                <span className="jt-disclosure" aria-hidden="true">
                  {row.childCount ? (
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 16 16"
                      className={row.expanded ? 'jt-open' : ''}
                    >
                      <path d="m6 4 4 4-4 4" />
                    </svg>
                  ) : null}
                </span>
                <span className="jt-key">
                  {row.key === undefined ? t('jsonTree.root') : row.key}
                  {row.keyTruncated ? '…' : ''}
                </span>
                <span className="jt-colon" aria-hidden="true">
                  :
                </span>
                <span className="jt-value">
                  {row.kind === 'Object' ? '{' : row.kind === 'Array' ? '[' : row.preview}
                  {row.previewTruncated ? '…' : ''}
                  {row.kind === 'Object' || row.kind === 'Array' ? (
                    <>
                      <span className="jt-size">
                        {row.childCount
                          ? t(row.kind === 'Array' ? 'jsonTree.items' : 'jsonTree.properties', {
                              count: row.childCount,
                            })
                          : ''}
                      </span>
                      {row.kind === 'Object' ? '}' : ']'}
                    </>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
        {detail && (
          <JsonDetailPanel
            client={client}
            id={selectedId}
            onClose={closeDetail}
            onReload={onReload}
          />
        )}
      </div>
      <div className="jt-footer">
        <Tooltip content={metadata?.pointer || t('jsonTree.root')}>
          <div className="jt-pointer">
            <span className="jt-pointer-symbol" aria-hidden="true">
              /
            </span>
            <code>
              {metadata?.pointer || t('jsonTree.root')}
              {metadata?.pointerTruncated ? '…' : ''}
            </code>
            {metadata?.pointerAmbiguous && (
              <span className="jt-duplicate">{t('jsonTree.duplicate')}</span>
            )}
          </div>
        </Tooltip>
        <div className="jt-tools">
          <JsonButton
            kind="copy"
            label={t('jsonTree.copyValue')}
            disabled={copying}
            onClick={() => {
              void copy('value');
            }}
          />
          <JsonButton
            kind="raw"
            label={t('jsonTree.copySubtree')}
            disabled={copying}
            onClick={() => {
              void copy('subtree');
            }}
          />
          <JsonButton
            kind="path"
            label={t('jsonTree.copyPointer')}
            disabled={copying}
            onClick={() => {
              void copy('pointer');
            }}
          />
          <JsonButton
            kind="detail"
            label={t('jsonTree.inspect')}
            onClick={() => {
              void openDetail();
            }}
          />
        </div>
      </div>
      <span className={copyStatus === 'failed' ? 'jt-copy-error' : 'sr-only'} role="status">
        {copyStatus ? t(copyStatus === 'done' ? 'jsonTree.copied' : 'jsonTree.copyFailed') : ''}
      </span>
    </div>
  );
}

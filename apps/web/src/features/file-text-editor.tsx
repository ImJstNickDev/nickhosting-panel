import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import {
  bracketMatching,
  defaultHighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { linter, lintGutter } from '@codemirror/lint';
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  searchKeymap,
  setSearchQuery,
} from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocale, useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
import { editorPhraseKeys, fileLanguage, validateFileSyntax } from './file-editor-model.js';

export type FileEditorControls = {
  focus: () => void;
  undo: () => void;
  redo: () => void;
  find: () => void;
  canUndo: boolean;
  canRedo: boolean;
};
export type FileTextEditorProps = {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onControls?: (controls: FileEditorControls | undefined) => void;
  readOnly?: boolean;
  shouldAutoFocus?: () => boolean;
  label: string;
};

function languageExtension(path: string): Extension {
  switch (fileLanguage(path)) {
    case 'json':
      return json();
    case 'yaml':
      return yaml();
    case 'toml':
      return StreamLanguage.define(toml);
    case 'properties':
      return StreamLanguage.define(properties);
    case 'javascript':
      return javascript({ jsx: /\.jsx$/i.test(path) });
    case 'typescript':
      return javascript({ typescript: true, jsx: /\.tsx$/i.test(path) });
    case 'python':
      return python();
    case 'shell':
      return StreamLanguage.define(shell);
    default:
      return [];
  }
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '0',
    fontSize: '0.9rem',
    backgroundColor: 'var(--surface)',
    color: 'inherit',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content:focus': { outline: 'none' },
  '@media (forced-colors: active)': {
    '&.cm-focused': { outline: '2px solid Highlight', outlineOffset: '-2px' },
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  },
  '.cm-content': { padding: '0.7rem 0', minHeight: '100%' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--muted)',
    borderRight: '1px solid var(--line)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--blue) 5%, transparent)',
  },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'inherit' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    color: 'inherit',
    border: '1px solid var(--line)',
  },
});

type SearchPanelState = { dom: HTMLDivElement; view: EditorView; state: EditorState };

function SearchIcon({
  kind,
}: {
  kind: 'previous' | 'next' | 'close' | 'replace' | 'replaceAll' | 'expand';
}) {
  const paths = {
    previous: 'm6 14 6-6 6 6',
    next: 'm6 10 6 6 6-6',
    close: 'm6 6 12 12M6 18 18 6',
    expand: 'm9 6 6 6-6 6',
    replace: 'M4 5h10m-3-3 3 3-3 3M4 19h16m-3-3 3 3-3 3M4 10v4h6v-4H4Z',
    replaceAll: 'M3 5h12m-3-3 3 3-3 3M3 11h12m-3-3 3 3-3 3M3 19h18m-3-3 3 3-3 3',
  };
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[kind]} />
    </svg>
  );
}

function CompactSearch({ view, state }: SearchPanelState) {
  const t = useT();
  const query = getSearchQuery(state);
  const { locale } = useLocale();
  const formatNumber = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const readOnly = state.readOnly;
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const doc = state.doc;
  const matches = useMemo(() => {
    const found: { from: number; to: number }[] = [];
    if (!query.valid) return found;
    // Use CodeMirror's query cursor; cap bookkeeping for large documents without altering search.
    const cursor = query.getCursor(doc);
    while (found.length <= 10000) {
      const next = cursor.next();
      if (next.done) break;
      found.push(next.value);
    }
    return found;
  }, [query, doc]);
  const selected = state.selection.main;
  const current =
    matches.findIndex((match) => match.from === selected.from && match.to === selected.to) + 1;
  const currentLabel = matches.length > 10000 && current === 0 ? '—' : formatNumber.format(current);
  const count = `${currentLabel} / ${formatNumber.format(Math.min(matches.length, 10000))}${matches.length > 10000 ? '+' : ''}`;
  const update = (change: Partial<ConstructorParameters<typeof SearchQuery>[0]>) => {
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ ...query, ...change })) });
  };
  const close = () => {
    closeSearchPanel(view);
    view.focus();
  };
  const action = (
    label: string,
    icon: Parameters<typeof SearchIcon>[0]['kind'],
    run: () => void,
    disabled = false,
  ) => (
    <Tooltip content={t(label)} placement="cursor">
      <button
        type="button"
        className="fm-tool"
        aria-label={t(label)}
        disabled={disabled}
        onClick={run}
      >
        <SearchIcon kind={icon} />
      </button>
    </Tooltip>
  );
  return (
    <search
      className="fm-search-panel"
      aria-label={t('editor.search')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          event.stopPropagation();
          if (query.valid) (event.shiftKey ? findPrevious : findNext)(view);
        }
      }}
    >
      <div className="fm-editor-search-row">
        <Tooltip content={t('editor.replace')} placement="cursor">
          <button
            type="button"
            className="fm-tool fm-replace-toggle"
            aria-label={t('editor.replace')}
            aria-expanded={expanded}
            disabled={readOnly}
            onClick={() => setExpanded(!expanded)}
          >
            <SearchIcon kind="expand" />
          </button>
        </Tooltip>
        <div className="fm-search-query">
          <input
            ref={input}
            main-field="true"
            name="search"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            aria-label={t('editor.search')}
            aria-invalid={query.search.length > 0 && !query.valid}
            placeholder={t('editor.search')}
            value={query.search}
            onChange={(event) => update({ search: event.target.value })}
          />
          {query.search && !query.valid ? (
            <Tooltip content={t('editor.invalidPattern')} placement="cursor">
              <span
                className="fm-search-invalid"
                role="status"
                aria-label={t('editor.invalidPattern')}
              >
                !
              </span>
            </Tooltip>
          ) : (
            <output aria-label={t('editor.matchCount')} aria-live="polite">
              {query.search ? count : ''}
            </output>
          )}
        </div>
        <div className="fm-search-options">
          {(
            [
              ['caseSensitive', 'editor.matchCase', 'Aa'],
              ['wholeWord', 'editor.byWord', 'ab'],
              ['regexp', 'editor.regexp', '.*'],
            ] as const
          ).map(([property, label, symbol]) => (
            <Tooltip key={property} content={t(label)} placement="cursor">
              <button
                type="button"
                className={`fm-tool fm-search-option fm-search-${property}`}
                aria-label={t(label)}
                aria-pressed={query[property]}
                onClick={() => update({ [property]: !query[property] })}
              >
                {symbol}
              </button>
            </Tooltip>
          ))}
          {action(
            'editor.previous',
            'previous',
            () => {
              findPrevious(view);
            },
            !query.valid,
          )}
          {action(
            'editor.next',
            'next',
            () => {
              findNext(view);
            },
            !query.valid,
          )}
          {action('editor.close', 'close', close)}
        </div>
      </div>
      {expanded && (
        <div className="fm-editor-replace-row">
          <input
            name="replace"
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            aria-label={t('editor.replaceWith')}
            placeholder={t('editor.replaceWith')}
            value={query.replace}
            disabled={readOnly}
            onChange={(event) => update({ replace: event.target.value })}
          />
          {action(
            'editor.replace',
            'replace',
            () => {
              replaceNext(view);
            },
            !query.valid || readOnly,
          )}
          {action(
            'editor.replaceAll',
            'replaceAll',
            () => {
              replaceAll(view);
            },
            !query.valid || readOnly,
          )}
        </div>
      )}
    </search>
  );
}

/** Tab indents; Escape then Tab leaves. No script execution, network LSP, or remote schema fetch. */
export function FileTextEditor({
  path,
  value,
  onChange,
  onSave,
  onControls,
  shouldAutoFocus,
  readOnly = false,
  label,
}: FileTextEditorProps) {
  const t = useT();
  const { locale } = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [searchPanel, setSearchPanel] = useState<SearchPanelState>();
  const configuration = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSave, onControls, shouldAutoFocus, readOnly, t });
  callbacks.current = { onChange, onSave, onControls, shouldAutoFocus, readOnly, t };
  const initialValue = useRef(value);
  initialValue.current = value;

  useEffect(() => {
    if (!host.current) return;
    const publishControls = (editor: EditorView) => {
      const run = (command: (view: EditorView) => boolean) => {
        command(editor);
        editor.focus();
      };
      callbacks.current.onControls?.({
        focus: () => editor.focus(),
        undo: () => {
          if (!callbacks.current.readOnly) run(undo);
        },
        redo: () => {
          if (!callbacks.current.readOnly) run(redo);
        },
        find: () => {
          openSearchPanel(editor);
        },
        canUndo: !callbacks.current.readOnly && undoDepth(editor.state) > 0,
        canRedo: !callbacks.current.readOnly && redoDepth(editor.state) > 0,
      });
    };
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialValue.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle),
          search({
            top: true,
            createPanel: (current) => {
              const dom = document.createElement('div');
              dom.className = 'fm-search-panel-host';
              const publish = () => setSearchPanel({ dom, view: current, state: current.state });
              return {
                dom,
                top: true,
                mount: publish,
                update: publish,
                destroy: () =>
                  setSearchPanel((active) => (active?.dom === dom ? undefined : active)),
              };
            },
          }),
          languageExtension(path),
          editorTheme,
          EditorView.lineWrapping,
          configuration.current.of([]),
          lintGutter(),
          linter(
            (current) =>
              (validateFileSyntax(path, current.state.doc.toString()) ?? []).map((issue) => ({
                from: issue.from,
                to: issue.to,
                severity: 'error',
                message: `${callbacks.current.t('editor.invalidSyntax')} · ${callbacks.current.t('editor.line', { line: issue.line })}`,
              })),
            { delay: 350 },
          ),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                if (!callbacks.current.readOnly) callbacks.current.onSave();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
            publishControls(update.view);
          }),
        ],
      }),
    });
    view.current = editor;
    publishControls(editor);
    const focusFrame = requestAnimationFrame(() => {
      if (callbacks.current.shouldAutoFocus?.()) editor.focus();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
      editor.destroy();
      view.current = null;
      callbacks.current.onControls?.(undefined);
    };
  }, [path]);

  // Both values invalidate configuration: a new path creates a new view and locale changes phrases.
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale and path intentionally reconfigure the imperative editor.
  useEffect(() => {
    view.current?.dispatch({
      effects: configuration.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({
          'aria-label': label,
          'aria-description': callbacks.current.t('editor.indentKeys'),
          'aria-multiline': 'true',
          'aria-readonly': String(readOnly),
          role: 'textbox',
          tabindex: '0',
          'data-1p-ignore': 'true',
          'data-lpignore': 'true',
        }),
        EditorState.phrases.of(
          Object.fromEntries(
            Object.entries(editorPhraseKeys).map(([phrase, key]) => [
              phrase,
              callbacks.current.t(`editor.${key}`),
            ]),
          ),
        ),
      ]),
    });
  }, [readOnly, label, locale, path]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return (
    <div className="file-text-editor">
      <div ref={host} />
      {searchPanel && createPortal(<CompactSearch {...searchPanel} />, searchPanel.dom)}
    </div>
  );
}

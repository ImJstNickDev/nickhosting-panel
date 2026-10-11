import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
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
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
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
import { useEffect, useRef } from 'react';
import { useLocale, useT } from '../app/i18n.js';
import { editorPhraseKeys, fileLanguage, validateFileSyntax } from './file-editor-model.js';

export type FileTextEditorProps = {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  readOnly?: boolean;
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
    height: 'min(62vh, 48rem)',
    minHeight: '16rem',
    fontSize: '0.9rem',
    backgroundColor: 'var(--surface)',
    color: 'inherit',
  },
  '&.cm-focused': { outline: '2px solid var(--blue)', outlineOffset: '-2px' },
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
  '.cm-search': {
    display: 'flex',
    gap: '0.4rem',
    flexWrap: 'wrap',
    padding: '0.6rem 2rem 0.6rem 0.6rem',
  },
  '.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '0.25rem' },
  '.cm-search input[type=checkbox]': { width: 'auto' },
  '.cm-search .cm-textfield': {
    minWidth: '8rem',
    maxWidth: '100%',
    width: '12rem',
    background: 'var(--surface)',
    color: 'inherit',
  },
  '.cm-search .cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--surface)',
    color: 'var(--blue)',
    borderColor: 'var(--line)',
    borderRadius: '4px',
    minHeight: '32px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    color: 'inherit',
    border: '1px solid var(--line)',
  },
});

/** A local editor. Tab leaves the editor; no script execution, network LSP, or remote schema fetch. */
export function FileTextEditor({
  path,
  value,
  onChange,
  onSave,
  readOnly = false,
  label,
}: FileTextEditorProps) {
  const t = useT();
  const { locale } = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const configuration = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSave, readOnly, t });
  callbacks.current = { onChange, onSave, readOnly, t };
  const initialValue = useRef(value);
  initialValue.current = value;

  useEffect(() => {
    if (!host.current) return;
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
          search({ top: true }),
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
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
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

  const command = (action: (editor: EditorView) => boolean) => {
    if (view.current) {
      action(view.current);
      view.current.focus();
    }
  };
  return (
    <div className="file-text-editor">
      <div className="file-editor-tools">
        <button type="button" className="secondary" onClick={() => command(openSearchPanel)}>
          {t('editor.search')}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={readOnly}
          onClick={() => command(undo)}
        >
          {t('editor.undo')}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={readOnly}
          onClick={() => command(redo)}
        >
          {t('editor.redo')}
        </button>
      </div>
      <div ref={host} />
    </div>
  );
}

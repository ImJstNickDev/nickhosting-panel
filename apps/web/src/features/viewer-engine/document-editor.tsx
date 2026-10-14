import { type ComponentType, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../app/i18n.js';
import { Tooltip } from '../../components/tooltip.js';
import { ErrorNotice } from '../../components/ui.js';
import {
  type FileEditorControls,
  FileTextEditor,
  type FileTextEditorProps,
} from '../file-text-editor.js';
import DelimitedView from './builtin-viewers/delimited.js';
import { JsonDocumentView } from './builtin-viewers/json.js';
import { documentViews } from './core/document-registry.js';
import type { DocumentViewControls, DocumentViewProps } from './core/document-view.js';
import type { ViewerId } from './core/registry.js';
import { ViewerIcon } from './viewer-icon.js';
import './document-editor.css';

const renderers: Readonly<Record<string, ComponentType<DocumentViewProps>>> = {
  sqlite: DelimitedView,
  json: JsonDocumentView,
};

/** One editable document; the host retains save revision, draft, authorization and recovery. */
export function DocumentEditor(
  props: FileTextEditorProps & {
    selectedView?: ViewerId;
    onViewChange?: (id: ViewerId) => void;
    actionTarget?: HTMLElement | null;
  },
) {
  const t = useT();
  const options = documentViews(props.path);
  const definition = options.find((item) => item.id === props.selectedView) ?? options[0];
  const active = props.selectedView !== 'text' && Boolean(definition);
  const Renderer = definition ? renderers[definition.id] : undefined;
  const [textControls, setTextControls] = useState<FileEditorControls>();
  const textRef = useRef(textControls);
  textRef.current = textControls;
  const [positionError, setPositionError] = useState<unknown>();
  const alternate = useRef<DocumentViewControls | undefined>(undefined);
  const [alternateControls, setAlternateControls] = useState<DocumentViewControls>();
  const current = useRef(props);
  current.current = props;
  const activeRef = useRef(active);
  activeRef.current = active;
  const registerAlternate = useCallback((controls: DocumentViewControls | undefined) => {
    alternate.current = controls;
    setAlternateControls(controls);
  }, []);
  const flush = useCallback(
    async () =>
      !activeRef.current || !alternate.current?.flush ? true : alternate.current.flush(),
    [],
  );
  useEffect(() => {
    if (!textControls) return;
    const focus = () => (activeRef.current ? alternate.current?.focus() : textControls.focus());
    current.current.onControls?.({
      ...textControls,
      pendingChanges: Boolean(alternateControls?.pendingChanges),
      canUndo: textControls.canUndo || Boolean(alternateControls?.pendingChanges),
      focus,
      flush,
      find: () => (activeRef.current ? alternate.current?.find?.() : textControls.find()),
      undo: () => {
        void flush().then((ok) => {
          if (ok) {
            textControls.undo();
            focus();
          }
        });
      },
      redo: () => {
        void flush().then((ok) => {
          if (ok) {
            textControls.redo();
            focus();
          }
        });
      },
    });
  }, [textControls, alternateControls, flush]);
  useEffect(() => () => current.current.onControls?.(undefined), []);
  const apply = useCallback(
    (next: string, expected: string) => {
      if (
        current.current.readOnly ||
        current.current.value !== expected ||
        !textControls?.replaceContent
      )
        return false;
      textControls.replaceContent(next);
      return true;
    },
    [textControls],
  );
  // Handle both the toolbar shortcut and Open With. Each renderer keeps its state while hidden.
  const displayed = useRef(active);
  useEffect(() => {
    const previous = displayed.current;
    displayed.current = active;
    if (previous === active) return;
    let cancelled = false;
    const outgoing = previous ? alternate.current : textRef.current;
    setPositionError(undefined);
    void (async () => {
      try {
        const position = await outgoing?.getPosition?.();
        if (cancelled) return;
        // Let the destination become visible before measuring/scrolling its viewport.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (cancelled) return;
        const incoming = active ? alternate.current : textRef.current;
        if (position) await incoming?.revealPosition?.(position);
        if (!cancelled) incoming?.focus();
      } catch (error) {
        if (!cancelled) setPositionError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);
  const switchView = async () => {
    if (!(await flush())) return;
    const id = active ? 'text' : definition?.id;
    if (!id) return;
    current.current.onViewChange?.(id);
  };
  return (
    <>
      {positionError ? <ErrorNotice error={positionError} /> : null}
      {Renderer &&
        definition &&
        props.actionTarget &&
        createPortal(
          <Tooltip content={t(active ? 'viewer.name.text' : definition.label)} placement="cursor">
            <button
              type="button"
              className="fm-tool document-view-switch"
              aria-label={t(active ? 'viewer.name.text' : definition.label)}
              onClick={() => {
                void switchView();
              }}
            >
              <ViewerIcon id={active ? 'text' : definition.id} />
            </button>
          </Tooltip>,
          props.actionTarget,
        )}
      <div className="document-view" hidden={active}>
        <FileTextEditor
          {...props}
          onControls={setTextControls}
          shouldAutoFocus={() => !activeRef.current && Boolean(current.current.shouldAutoFocus?.())}
        />
      </div>
      {Renderer && (
        // biome-ignore lint/a11y/useSemanticElements: A shared document surface is not a form fieldset.
        <div
          role="group"
          aria-label={t(definition?.label ?? 'viewer.name.text')}
          className="document-view"
          hidden={!active}
          onKeyDown={(event) => {
            if (
              !(event.ctrlKey || event.metaKey) ||
              event.altKey ||
              event.nativeEvent.isComposing ||
              event.defaultPrevented
            )
              return;
            const key = event.key.toLowerCase();
            if (key === 's') {
              event.preventDefault();
              event.stopPropagation();
              props.onSave();
            } else if (
              (key === 'z' || key === 'y') &&
              !(event.target as HTMLElement).closest('input,textarea,[contenteditable]')
            ) {
              event.preventDefault();
              void flush().then((ok) => {
                if (!ok) return;
                if (key === 'y' || event.shiftKey) textControls?.redo();
                else textControls?.undo();
                alternate.current?.focus();
              });
            }
          }}
        >
          <Renderer
            path={props.path}
            value={props.value}
            active={active}
            readOnly={Boolean(props.readOnly)}
            onChange={apply}
            onSave={props.onSave}
            onControls={registerAlternate}
          />
        </div>
      )}
    </>
  );
}

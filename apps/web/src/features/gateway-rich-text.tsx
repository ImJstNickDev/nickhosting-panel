import { type Ref, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { MessageChannel } from './gateway-message-preview.js';
import {
  deleteRichMessage,
  insertRichMessageToken,
  type RichMessageEdit,
  type RichMessageSelection,
  replaceRichMessage,
  richMessageParts,
} from './gateway-rich-text-model.js';

export interface GatewayRichTextHandle {
  insert(token: string): void;
  undo(): void;
  redo(): void;
  focus(): void;
}
interface GatewayRichTextProps {
  value: string;
  onChange(value: string): void;
  channel: MessageChannel;
  variables: Record<string, string>;
  label: string;
  readOnly: boolean;
  editorRef?: Ref<GatewayRichTextHandle>;
}

function sourceOffset(root: HTMLElement, node: Node, offset: number): number | undefined {
  if (!root.contains(node) && node !== root) return undefined;
  if (node === root) {
    const previous = root.childNodes.item(offset - 1);
    const next = root.childNodes.item(offset);
    if (next instanceof HTMLElement && next.dataset.start !== undefined)
      return Number(next.dataset.start);
    return previous instanceof HTMLElement ? Number(previous.dataset.end ?? 0) : 0;
  }
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const part = element?.closest<HTMLElement>('[data-start]');
  if (!part || !root.contains(part)) return undefined;
  const start = Number(part.dataset.start);
  const end = Number(part.dataset.end);
  if (part.dataset.kind !== 'text') return offset === 0 ? start : end;
  return Math.min(end, start + offset);
}
function readSelection(root: HTMLElement): RichMessageSelection | undefined {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !selection.focusNode) return undefined;
  const anchor = sourceOffset(root, selection.anchorNode, selection.anchorOffset);
  const focus = sourceOffset(root, selection.focusNode, selection.focusOffset);
  if (anchor === undefined || focus === undefined) return undefined;
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}
function restoreSelection(root: HTMLElement, selection: RichMessageSelection) {
  const point = (offset: number): [Node, number] => {
    const children = [...root.children] as HTMLElement[];
    for (const [index, element] of children.entries()) {
      const start = Number(element.dataset.start);
      const end = Number(element.dataset.end);
      if (element.dataset.kind === 'format') continue;
      if (element.dataset.kind === 'text' && offset >= start && offset <= end && element.firstChild)
        return [element.firstChild, offset - start];
      if (offset <= start) return [root, index];
      if (offset < end) return [root, index + 1];
    }
    return [root, root.childNodes.length];
  };
  const start = point(selection.start);
  const end = point(selection.end);
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  const browserSelection = window.getSelection();
  browserSelection?.removeAllRanges();
  browserSelection?.addRange(range);
}

/** A small controlled editor. DOM is rebuilt only on source/style changes; text,
 * formatting and variable offsets remain separate from their displayed values. */
export function GatewayRichText(props: GatewayRichTextProps) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const value = useRef(props.value);
  const received = useRef(props.value);
  const selection = useRef<RichMessageSelection>({ start: 0, end: 0 });
  const history = useRef<{ undo: RichMessageEdit[]; redo: RichMessageEdit[] }>({
    undo: [],
    redo: [],
  });
  const composition = useRef<RichMessageEdit | null>(null);
  const rendered = useRef('');

  function draw(force = false) {
    const element = root.current;
    if (!element) return;
    const { channel, variables } = latest.current;
    const signature = JSON.stringify([value.current, channel.formatting, variables]);
    if (!force && rendered.current === signature) return;
    rendered.current = signature;
    const fragment = document.createDocumentFragment();
    for (const part of richMessageParts(value.current, channel, variables)) {
      const span = document.createElement('span');
      span.dataset.start = String(part.start);
      span.dataset.end = String(part.end);
      span.dataset.kind = part.kind;
      span.textContent = part.text;
      if (part.kind === 'format') {
        span.hidden = true;
        span.setAttribute('aria-hidden', 'true');
      } else {
        if (part.kind === 'variable') {
          span.contentEditable = 'false';
          span.className = 'gateway-rich-text-variable';
          span.dataset.variable = part.source;
          span.setAttribute('aria-label', part.source);
        }
        if (part.style.color) span.style.color = part.style.color;
        if (part.style.bold) span.style.fontWeight = 'bold';
        if (part.style.italic) span.style.fontStyle = 'italic';
        span.style.textDecoration = [
          part.style.underline && 'underline',
          part.style.strike && 'line-through',
        ]
          .filter(Boolean)
          .join(' ');
      }
      fragment.append(span);
    }
    if (value.current.endsWith('\n')) {
      const tail = document.createElement('br');
      tail.dataset.start = String(value.current.length);
      tail.dataset.end = String(value.current.length);
      fragment.append(tail);
    }
    element.replaceChildren(fragment);
  }
  function rememberSelection() {
    if (root.current) selection.current = readSelection(root.current) ?? selection.current;
  }
  function commit(edit: RichMessageEdit | undefined, record = true) {
    if (!edit || latest.current.readOnly) return;
    if (record && edit.value !== value.current) {
      history.current.undo.push({ value: value.current, selection: { ...selection.current } });
      if (history.current.undo.length > 100) history.current.undo.shift();
      history.current.redo = [];
    }
    const changed = edit.value !== value.current;
    value.current = edit.value;
    selection.current = edit.selection;
    draw(true);
    if (root.current) {
      root.current.focus({ preventScroll: true });
      restoreSelection(root.current, edit.selection);
    }
    if (changed) latest.current.onChange(edit.value);
  }
  function restoreHistory(direction: 'undo' | 'redo') {
    if (latest.current.readOnly) return;
    rememberSelection();
    const edit = history.current[direction].pop();
    if (!edit) return;
    history.current[direction === 'undo' ? 'redo' : 'undo'].push({
      value: value.current,
      selection: { ...selection.current },
    });
    commit(edit, false);
  }
  function insert(text: string, token = false) {
    rememberSelection();
    const { channel, variables } = latest.current;
    const edit = (token ? insertRichMessageToken : replaceRichMessage)(
      value.current,
      selection.current,
      text,
      channel,
      variables,
    );
    commit(edit);
  }
  useImperativeHandle(props.editorRef, () => ({
    insert: (token) => insert(token, true),
    undo: () => restoreHistory('undo'),
    redo: () => restoreHistory('redo'),
    focus: () => {
      root.current?.focus({ preventScroll: true });
      if (root.current) restoreSelection(root.current, selection.current);
    },
  }));

  useLayoutEffect(() => {
    if (received.current !== props.value) {
      received.current = props.value;
      if (props.value !== value.current) {
        value.current = props.value;
        selection.current = { start: props.value.length, end: props.value.length };
        history.current = { undo: [], redo: [] };
      }
    }
    if (composition.current) return;
    const focused = document.activeElement === root.current;
    rememberSelection();
    draw();
    if (focused && root.current) restoreSelection(root.current, selection.current);
  });

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const input = (event: InputEvent) => {
      if (event.isComposing || composition.current) return;
      event.preventDefault();
      if (latest.current.readOnly) return;
      rememberSelection();
      const { channel, variables } = latest.current;
      switch (event.inputType) {
        case 'insertText':
        case 'insertReplacementText':
          insert(event.data ?? '');
          break;
        case 'insertParagraph':
        case 'insertLineBreak':
          if (channel.multiline) insert('\n');
          break;
        case 'deleteContentBackward':
        case 'deleteContentForward':
          commit(
            deleteRichMessage(
              value.current,
              selection.current,
              event.inputType === 'deleteContentBackward' ? 'backward' : 'forward',
              channel,
              variables,
            ),
          );
          break;
        case 'deleteWordBackward':
        case 'deleteWordForward':
        case 'deleteSoftLineBackward':
        case 'deleteSoftLineForward': {
          const target = event.getTargetRanges?.()[0];
          let range = selection.current;
          if (target) {
            const start = sourceOffset(element, target.startContainer, target.startOffset);
            const end = sourceOffset(element, target.endContainer, target.endOffset);
            if (start !== undefined && end !== undefined) range = { start, end };
          } else if (range.start === range.end) {
            const backward = event.inputType.endsWith('Backward');
            const word = event.inputType.startsWith('deleteWord');
            if (backward) {
              const preceding = value.current.slice(0, range.start);
              const match = preceding.match(word ? /(?:\S+\s*|\s+)$/u : /[^\n]*$/u);
              range = { start: range.start - (match?.[0].length ?? 0), end: range.end };
            } else {
              const following = value.current.slice(range.end);
              const match = following.match(word ? /^(?:\s*\S+|\s+)/u : /^[^\n]*/u);
              range = { start: range.start, end: range.end + (match?.[0].length ?? 0) };
            }
          }
          commit(replaceRichMessage(value.current, range, '', channel, variables));
          break;
        }
        case 'historyUndo':
          restoreHistory('undo');
          break;
        case 'historyRedo':
          restoreHistory('redo');
          break;
        default:
          break;
      }
    };
    const remember = () => rememberSelection();
    element.addEventListener('beforeinput', input);
    document.addEventListener('selectionchange', remember);
    return () => {
      element.removeEventListener('beforeinput', input);
      document.removeEventListener('selectionchange', remember);
    };
  });

  return (
    // biome-ignore lint/a11y/useSemanticElements: Rich formatting and atomic variables require contenteditable, not a plain textarea.
    <div
      ref={root}
      className="gateway-rich-text"
      role="textbox"
      aria-label={props.label}
      aria-multiline={props.channel.multiline}
      aria-readonly={props.readOnly}
      contentEditable={!props.readOnly}
      suppressContentEditableWarning
      tabIndex={0}
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', minHeight: '1em' }}
      onFocus={rememberSelection}
      onBlur={rememberSelection}
      onInput={() => {
        if (!composition.current) {
          draw(true);
          if (root.current) restoreSelection(root.current, selection.current);
        }
      }}
      onCompositionStart={() => {
        rememberSelection();
        composition.current = { value: value.current, selection: { ...selection.current } };
      }}
      onCompositionEnd={(event) => {
        const original = composition.current;
        composition.current = null;
        if (!original) return;
        selection.current = original.selection;
        const edit = replaceRichMessage(
          original.value,
          original.selection,
          event.data,
          latest.current.channel,
          latest.current.variables,
        );
        if (edit) commit(edit);
        else {
          draw(true);
          if (root.current) restoreSelection(root.current, original.selection);
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        insert(event.clipboardData.getData('text/plain'));
      }}
      onDrop={(event) => {
        event.preventDefault();
        // A drop never imports HTML or files into a message.
        insert(event.dataTransfer.getData('text/plain'));
      }}
      onCopy={(event) => {
        rememberSelection();
        if (selection.current.start === selection.current.end) return;
        event.preventDefault();
        event.clipboardData.setData(
          'text/plain',
          value.current.slice(selection.current.start, selection.current.end),
        );
      }}
      onCut={(event) => {
        rememberSelection();
        if (props.readOnly || selection.current.start === selection.current.end) return;
        event.preventDefault();
        event.clipboardData.setData(
          'text/plain',
          value.current.slice(selection.current.start, selection.current.end),
        );
        insert('');
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        const modified = (event.ctrlKey || event.metaKey) && !event.altKey;
        if (!modified) return;
        const key = event.key.toLowerCase();
        if (key === 'z' || key === 'y') {
          event.preventDefault();
          restoreHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo');
        } else if (['b', 'i', 'u'].includes(key)) {
          event.preventDefault();
          const property = key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline';
          const token = props.channel.formatting?.tokens.find((item) => item.style?.[property]);
          if (token) insert(token.value, true);
        }
      }}
    />
  );
}

import { invertedEffects } from '@codemirror/commands';
import { type EditorState, StateEffect, StateField, type Transaction } from '@codemirror/state';

/** CodeMirror uses logical LF lines; this field keeps the file's exact untouched bytes. */
type Source = { text: string; starts: number[]; separator: string };
type Patch = { from: number; to: number; insert: string };
const sourcePatch = StateEffect.define<Patch>();
function source(text: string): Source {
  const starts = [0];
  let separator: string | undefined;
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    separator ??= match[0];
    starts.push(match.index + match[0].length);
  }
  return { text, starts, separator: separator ?? '\n' };
}
function difference(before: string, after: string): Patch {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let to = before.length;
  let end = after.length;
  while (to > from && end > from && before[to - 1] === after[end - 1]) {
    to--;
    end--;
  }
  return { from, to, insert: after.slice(from, end) };
}
function apply(value: Source, tr: Transaction): Source {
  const patches = tr.effects.filter((effect) => effect.is(sourcePatch));
  if (patches.length) {
    let text = value.text;
    for (const { value: patch } of patches)
      text = text.slice(0, patch.from) + patch.insert + text.slice(patch.to);
    return source(text);
  }
  if (!tr.docChanged) return value;
  const rawOffset = (position: number) => {
    const line = tr.startState.doc.lineAt(position);
    return (value.starts[line.number - 1] ?? 0) + position - line.from;
  };
  let text = '',
    consumed = 0;
  tr.changes.iterChanges((from, to, _fromB, _toB, insert) => {
    text +=
      value.text.slice(consumed, rawOffset(from)) +
      insert.sliceString(0, insert.length, value.separator);
    consumed = rawOffset(to);
  });
  return source(text + value.text.slice(consumed));
}
export const fileDocument = StateField.define<Source>({
  create: (state) => source(state.doc.toString()),
  update: apply,
});
export function fileDocumentExtensions(value: string) {
  return [
    fileDocument.init(() => source(value)),
    invertedEffects.of((tr) => {
      const before = tr.startState.field(fileDocument);
      const after = apply(before, tr);
      return before.text === after.text
        ? []
        : [sourcePatch.of(difference(after.text, before.text))];
    }),
  ];
}
/** Trusted view replacement: minimal normalized edit plus exact raw edit, sharing undo. */
export function replaceFileDocument(state: EditorState, value: string) {
  const before = state.field(fileDocument).text;
  if (before === value) return undefined;
  return {
    changes: difference(state.doc.toString(), state.toText(value).toString()),
    effects: sourcePatch.of(difference(before, value)),
  };
}

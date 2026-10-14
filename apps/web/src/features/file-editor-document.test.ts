import { history, isolateHistory, redo, undo } from '@codemirror/commands';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  fileDocument,
  fileDocumentExtensions,
  replaceFileDocument,
} from './file-editor-document.js';

function document(value: string) {
  let state = EditorState.create({
    doc: value,
    extensions: [history(), fileDocumentExtensions(value)],
  });
  return {
    get state() {
      return state;
    },
    dispatch(tr: Transaction) {
      state = tr.state;
    },
    replace(value: string) {
      const change = replaceFileDocument(state, value);
      if (change) state = state.update({ ...change, annotations: isolateHistory.of('full') }).state;
    },
    type(from: number, insert: string) {
      state = state.update({
        changes: { from, insert },
        annotations: Transaction.userEvent.of('input.type'),
      }).state;
    },
    raw() {
      return state.field(fileDocument).text;
    },
  };
}
describe('shared exact file document', () => {
  it.each(['\n', '\r', '\r\n'])(
    'preserves embedded newlines and undo with record separator %j',
    (separator) => {
      const original = `name,value${separator}"a\r\nb\nc\rd",001${separator}`;
      const editor = document(original);
      editor.replace(original.replace('001', '009'));
      expect(editor.raw()).toBe(original.replace('001', '009'));
      expect(undo(editor)).toBe(true);
      expect(editor.raw()).toBe(original);
      expect(redo(editor)).toBe(true);
      expect(editor.raw()).toBe(original.replace('001', '009'));
      editor.type(0, 'x');
      editor.type(1, 'y');
      expect(editor.raw()).toBe(`xy${original.replace('001', '009')}`);
      undo(editor);
      expect(editor.raw()).toBe(original.replace('001', '009'));
      redo(editor);
      expect(editor.raw()).toBe(`xy${original.replace('001', '009')}`);
    },
  );
  it('preserves unchanged separators for typing, multi-range replacement and deleting a line', () => {
    const editor = document('a\r\nb\nc\rd');
    editor.dispatch(
      editor.state.update({
        changes: [
          { from: 2, to: 3, insert: 'B' },
          { from: 4, to: 5, insert: 'C' },
        ],
      }),
    );
    expect(editor.raw()).toBe('a\r\nB\nC\rd');
    editor.dispatch(
      editor.state.update({ changes: { from: 2, to: 4 }, annotations: isolateHistory.of('full') }),
    );
    expect(editor.raw()).toBe('a\r\nC\rd');
    undo(editor);
    expect(editor.raw()).toBe('a\r\nB\nC\rd');
    editor.type(editor.state.doc.length, '\nx');
    expect(editor.raw()).toBe('a\r\nB\nC\rd\r\nx');
  });
  it('records raw-only changes even when the normalized CodeMirror document is identical', () => {
    const editor = document('a\nb');
    editor.replace('a\r\nb');
    expect(editor.raw()).toBe('a\r\nb');
    undo(editor);
    expect(editor.raw()).toBe('a\nb');
    redo(editor);
    expect(editor.raw()).toBe('a\r\nb');
  });
  it('external document replacement resets old history without changing the new raw source', () => {
    const compartment = new Compartment();
    let state = EditorState.create({
      doc: 'a\r\nb',
      extensions: [compartment.of(history()), fileDocumentExtensions('a\r\nb')],
    });
    state = state.update({ changes: { from: 0, insert: 'X' } }).state;
    const replacement = replaceFileDocument(state, 'new\r\nfile');
    if (!replacement) throw new Error('Expected replacement');
    state = state.update({
      ...replacement,
      effects: [replacement.effects, compartment.reconfigure([])],
      annotations: Transaction.addToHistory.of(false),
    }).state;
    state = state.update({ effects: compartment.reconfigure(history()) }).state;
    expect(
      undo({
        state,
        dispatch: () => {
          throw new Error('Old undo survived');
        },
      }),
    ).toBe(false);
    expect(state.field(fileDocument).text).toBe('new\r\nfile');
    expect(state.doc.toString()).toBe('new\nfile');
  });
});

import { describe, expect, it } from 'vitest';
import {
  decodeEditableText,
  FILE_EDITOR_MAX_BYTES,
  fileEditorAvailability,
} from './file-content.js';

describe('text editor metadata policy', () => {
  it.each([
    'server.jar',
    'WORLD.DAT',
    'r.0.0.mca',
    'level.nbt',
    'store.sqlite',
    'backup.tar.gz',
    'plugin.zip',
    'head.png',
    'font.woff2',
    'document.pdf',
  ])('rejects known binary extension %s even when MIME says text', (name) => {
    expect(fileEditorAvailability({ name, mimetype: 'text/plain', size: 10 })).toBe('binary');
  });
  it.each([
    'application/java-archive',
    'application/zip',
    'application/pdf',
    'image/png',
    'audio/ogg',
    'video/mp4',
  ])('rejects known binary MIME %s despite misleading text filename', (mimetype) => {
    expect(fileEditorAvailability({ name: 'renamed.txt', mimetype })).toBe('binary');
  });
  it.each(['latest.log', 'server.properties', '.env', 'LICENSE', 'strange.extension', 'view.svg'])(
    'keeps %s eligible for byte validation with unknown MIME',
    (name) => {
      expect(fileEditorAvailability({ name, mimetype: 'application/octet-stream' })).toBe('text');
    },
  );
  it('retains UTF-8 SVG/XML as text and preserves the existing bounded size', () => {
    expect(fileEditorAvailability({ name: 'view.svg', mimetype: 'image/svg+xml' })).toBe('text');
    expect(fileEditorAvailability({ name: 'a.txt', size: FILE_EDITOR_MAX_BYTES })).toBe('text');
    expect(fileEditorAvailability({ name: 'a.txt', size: FILE_EDITOR_MAX_BYTES + 1 })).toBe(
      'too_large',
    );
  });
  it('does not offer text editing for directories, links or invalid metadata', () => {
    expect(fileEditorAvailability({ name: 'folder', is_file: false })).toBe('unavailable');
    expect(fileEditorAvailability({ name: 'link.txt', is_symlink: true })).toBe('unavailable');
    expect(fileEditorAvailability({ name: 'a.txt', size: Number.NaN })).toBe('unavailable');
    expect(fileEditorAvailability({ name: 'a.txt', size: -1 })).toBe('unavailable');
  });
});

describe('strict text content validation', () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  it.each([
    '',
    '\ufeff# Italiano: città\r\n日本語 🙂\t= sì\v\f\u0085',
    '{"value": "é"}',
    '#!/bin/sh\necho "done"\n',
  ])('preserves ordinary Unicode, BOM and text whitespace: %s', (text) => {
    expect(decodeEditableText(encode(text))).toBe(text);
  });
  it.each([[0xc3, 0x28], [0xff], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xc0, 0xaf]])(
    'rejects malformed UTF-8 %j instead of replacement decoding',
    (...bytes) => {
      expect(() => decodeEditableText(new Uint8Array(bytes))).toThrow('file_not_editable');
    },
  );
  it.each([0, 1, 7, 14, 27, 31, 127, 128, 159])('rejects binary control U+%i', (code) => {
    expect(() => decodeEditableText(encode(`prefix${String.fromCodePoint(code)}suffix`))).toThrow(
      'file_not_editable',
    );
  });
  it.each([
    '%PDF-1.7\nhello',
    'SQLite format 3',
    'RIFF0000WAVEdata',
    'RIFF0000WEBPdata',
    `OggS${'x'.repeat(30)}`,
    `${' '.repeat(257)}ustar${' '.repeat(250)}`,
  ])('rejects an ASCII-compatible binary signature', (text) => {
    expect(() => decodeEditableText(encode(text))).toThrow('file_not_editable');
  });
  it('rejects oversize bytes before decoding', () => {
    expect(() => decodeEditableText(new Uint8Array(FILE_EDITOR_MAX_BYTES + 1))).toThrow(
      'validation_failed',
    );
  });
});

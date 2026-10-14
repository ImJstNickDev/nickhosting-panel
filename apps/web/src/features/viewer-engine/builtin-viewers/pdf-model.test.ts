import { afterEach, describe, expect, it, vi } from 'vitest';
import { pdfWebLink, readPdfPosition, savePdfPosition } from './pdf-model.js';

const key = 'nh.folio.positions.v1';
afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  const result = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => values.set(name, value)),
  };
  vi.stubGlobal('sessionStorage', result);
  return result;
}

describe('Folio passive links', () => {
  it('allows only absolute HTTP(S) links without embedded credentials', () => {
    expect(pdfWebLink('https://example.test/a?q=chapter#two')).toBe(
      'https://example.test/a?q=chapter#two',
    );
    expect(pdfWebLink('HTTP://EXAMPLE.TEST/path')).toBe('http://example.test/path');
    for (const link of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///private/document',
      'ftp://example.test/a',
      'mailto:a@example.test',
      '/servers/private',
      '//example.test/a',
      '#page=2',
      'https://user:secret@example.test/a',
      'https://user@example.test/a',
      'https://:secret@example.test/a',
      'not a URL',
    ]) {
      expect(pdfWebLink(link), link).toBeUndefined();
    }
  });
});

describe('Folio per-tab reading position', () => {
  it('retains only the latest twenty document positions and moves revisited documents first', () => {
    const session = storage();
    for (let index = 0; index < 25; index++)
      savePdfPosition(`server:file-${index}`, { page: index + 1, scale: 'page-fit', rotation: 0 });
    expect(readPdfPosition('server:file-0')).toBeUndefined();
    expect(readPdfPosition('server:file-5')).toEqual({ page: 6, scale: 'page-fit', rotation: 0 });
    savePdfPosition('server:file-5', { page: 3, scale: '1.5', rotation: 90 });
    const saved = JSON.parse(session.getItem(key) ?? '[]') as unknown[];
    expect(saved).toHaveLength(20);
    expect(saved[0]).toEqual(['server:file-5', { page: 3, scale: '1.5', rotation: 90 }]);
    expect(readPdfPosition('server:file-5')).toEqual({ page: 3, scale: '1.5', rotation: 90 });
  });

  it('rejects malformed persisted positions before viewer navigation', () => {
    const session = storage();
    for (const raw of ['{', '{}', 'null', '[null]', '["document"]']) {
      session.setItem(key, raw);
      expect(readPdfPosition('document')).toBeUndefined();
    }
    for (const value of [
      { page: 0, scale: 'page-fit', rotation: 0 },
      { page: -1, scale: 'page-fit', rotation: 0 },
      { page: 1.5, scale: 'page-fit', rotation: 0 },
      { page: '1', scale: 'page-fit', rotation: 0 },
      { page: 1, scale: 'page-fit', rotation: 45 },
      { page: 1, scale: 'page-fit', rotation: 360 },
      { page: 1, scale: '0.09', rotation: 0 },
      { page: 1, scale: '25.1', rotation: 0 },
      { page: 1, scale: 'Infinity', rotation: 0 },
      { page: 1, scale: 'auto', rotation: 0 },
      { page: 1, scale: true, rotation: 0 },
      { page: 1, scale: ['1'], rotation: 0 },
    ]) {
      session.setItem(key, JSON.stringify([['document', value]]));
      expect(readPdfPosition('document'), JSON.stringify(value)).toBeUndefined();
    }
    for (const scale of ['0.1', '25', 'page-width', 'page-fit']) {
      session.setItem(key, JSON.stringify([['document', { page: 1, scale, rotation: 270 }]]));
      expect(readPdfPosition('document')).toEqual({ page: 1, scale, rotation: 270 });
    }
  });

  it('tolerates unavailable storage and write quota failures', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('Storage disabled');
      },
      setItem: () => {
        throw new Error('Storage disabled');
      },
    });
    expect(readPdfPosition('document')).toBeUndefined();
    expect(() =>
      savePdfPosition('document', { page: 1, scale: 'page-width', rotation: 0 }),
    ).not.toThrow();
    const session = storage();
    session.setItem.mockImplementation(() => {
      throw new Error('Quota exceeded');
    });
    expect(() =>
      savePdfPosition('document', { page: 1, scale: 'page-width', rotation: 0 }),
    ).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { formatQuillBibliography } from './bibliography.js';

describe('Quill local bibliographies', () => {
  it('normalizes BibTeX without external resolution', () => {
    const result = formatQuillBibliography(
      '@book{lovelace1843, author={Ada Lovelace}, title={Notes}, year={1843}}',
      'bibtex',
    );
    expect(result.entries[0]).toMatchObject({ id: 'lovelace1843', label: 'Lovelace, 1843' });
    expect(result.entries[0]?.text).toContain('Notes');
  });
  it('keeps CSL-JSON text inert and offers numbered references', () => {
    expect(
      formatQuillBibliography(
        JSON.stringify([{ id: 'a', title: '<img onerror=alert(1)>' }]),
        'json',
        'numeric',
      ).entries,
    ).toEqual([{ id: 'a', label: '1', text: '<img onerror=alert(1)>' }]);
  });
  it('rejects ambiguous IDs and oversized input', () => {
    expect(() => formatQuillBibliography('[{"id":"a"},{"id":"a"}]', 'json')).toThrow();
    expect(() => formatQuillBibliography('a'.repeat(524289), 'bibtex')).toThrow();
    expect(() => formatQuillBibliography('https://example.com/bib', 'json')).toThrow();
  });
});

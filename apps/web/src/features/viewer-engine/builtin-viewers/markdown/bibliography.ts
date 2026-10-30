import { Cite, type CSL } from '@citation-js/core';
import '@citation-js/plugin-bibtex';

export interface QuillBibliography {
  entries: { id: string; label: string; text: string }[];
}

/** Local data only; basic presentation styles, not a claim of CSL/Pandoc compatibility. */
export function formatQuillBibliography(
  source: string,
  format: 'bibtex' | 'json',
  style: 'author-year' | 'numeric' = 'author-year',
): QuillBibliography {
  if (new TextEncoder().encode(source).byteLength > 512 * 1024)
    throw new Error('quill.bibliographyLimit');
  let data: CSL[];
  if (format === 'json') {
    const parsed: unknown = JSON.parse(source);
    if (!Array.isArray(parsed) || parsed.length > 1000)
      throw new Error('quill.bibliographyInvalid');
    data = parsed as CSL[];
  } else {
    // Force the local BibTeX parser: never auto-detect URLs/DOIs or use asynchronous resolvers.
    data = new Cite(source, {
      forceType: '@bibtex/text',
      target: '@csl/list+object',
      strict: true,
      maxChainLength: 10,
      generateGraph: false,
    }).data;
  }
  if (data.length > 1000) throw new Error('quill.bibliographyLimit');
  const ids = new Set<string>();
  const plain = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 4096) : '';
  return {
    entries: data.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw new Error('quill.bibliographyInvalid');
      const id = plain(entry['citation-key'] ?? entry.id);
      if (!id || ids.has(id)) throw new Error('quill.bibliographyInvalid');
      ids.add(id);
      const names = Array.isArray(entry.author)
        ? entry.author
            .slice(0, 32)
            .map((name) =>
              name && typeof name === 'object'
                ? plain(name.literal) ||
                  [plain(name.given), plain(name.family)].filter(Boolean).join(' ')
                : '',
            )
            .filter(Boolean)
        : [];
      const first = entry.author?.[0];
      const author =
        (first && (plain(first.family) || plain(first.literal))) || plain(entry.title) || id;
      const year = plain(entry.issued?.['date-parts']?.[0]?.[0]) || plain(entry.issued?.literal);
      return {
        id,
        label: style === 'numeric' ? String(index + 1) : [author, year].filter(Boolean).join(', '),
        // React renders these as text. Bibliographic markup never becomes executable HTML.
        text: [
          names.join('; '),
          year && `(${year})`,
          plain(entry.title),
          plain(entry['container-title']),
          plain(entry.publisher),
          plain(entry.DOI) || plain(entry.URL),
        ]
          .filter(Boolean)
          .join('. '),
      };
    }),
  };
}

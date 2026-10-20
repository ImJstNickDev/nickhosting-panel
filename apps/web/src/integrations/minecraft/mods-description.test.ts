import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ModsDescription, parseModDescription } from './mods-description.js';

vi.mock('../../app/i18n.js', () => ({
  useT: () => (key: string) => key,
}));

describe('provider mod descriptions', () => {
  it('retains GFM document structure without enabling executable provider HTML', () => {
    const tree = parseModDescription(
      '# Example\n\n**Ready**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n<script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(2)"><iframe src="https://example.test"></iframe>',
      'markdown',
    );
    const json = JSON.stringify(tree);
    expect(json).toContain('"tagName":"h1"');
    expect(json).toContain('"tagName":"table"');
    expect(json).toContain('"tagName":"strong"');
    expect(json).not.toContain('"tagName":"script"');
    expect(json).not.toContain('"tagName":"iframe"');
    expect(json).not.toContain('javascript:');
    expect(json).not.toContain('onError');
  });
  it('removes provider classes, styles, event attributes and DOM identifiers from HTML', () => {
    const tree = parseModDescription(
      '<h2 id="root" class="overlay" style="position:fixed">Title</h2><a href="data:text/html,test" onclick="alert(1)">Open</a><form><input name="password"></form>',
      'html',
    );
    const json = JSON.stringify(tree);
    expect(json).toContain('Title');
    expect(json).not.toContain('position:fixed');
    expect(json).not.toContain('onClick');
    expect(json).not.toContain('"id":"root"');
    expect(json).not.toContain('"tagName":"form"');
    expect(json).not.toContain('data:text/html');
  });
  it.each([
    ['html', '<p>Before<br>After</p><hr><p>Ready</p>'],
    ['markdown', 'Before  \nAfter\n\n---\n\nReady'],
  ] as const)(
    'renders void elements in %s descriptions without passing React children',
    (format, text) => {
      const html = renderToStaticMarkup(createElement(ModsDescription, { text, format }));
      expect(html).toMatch(/<p>Before<br\/>\s*After<\/p>/);
      expect(html).toContain('<hr/>');
      expect(html).toContain('<p>Ready</p>');
    },
  );
  it('renders sanitized HTML while deferring external images until the user requests them', () => {
    const html = renderToStaticMarkup(
      createElement(ModsDescription, {
        format: 'html',
        text: '<p>Before<br onclick="alert(1)">After</p><hr><img src="https://example.test/banner.png" onerror="alert(2)" alt="Banner"><img src="javascript:alert(3)"><script>alert(4)</script><a href="javascript:alert(5)">Unsafe link</a><a href="https://example.test/docs">Documentation</a>',
      }),
    );
    expect(html).toContain('<p>Before<br/>After</p>');
    expect(html).toContain('<hr/>');
    expect(html).not.toContain('<img');
    expect(html).toContain('loadImages');
    expect(html).not.toContain('alert(');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).toContain('<span>Unsafe link</span>');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  });
});

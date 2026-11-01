import { describe, expect, it } from 'vitest';
import { QUILL_LIMITS, type QuillElement, type QuillNode } from './model';
import { parseMarkdown } from './parser';

function elements(nodes: QuillNode[]): QuillElement[] {
  return nodes.flatMap((node) =>
    node.type === 'element' ? [node, ...elements(node.children)] : [],
  );
}
function content(nodes: QuillNode[]): string {
  return nodes.map((node) => (node.type === 'text' ? node.value : content(node.children))).join('');
}

describe('Quill Markdown parser', () => {
  it('renders GFM, accessible tasks, definitions, footnotes and exact source offsets', async () => {
    const source =
      '\uFEFF# Hello\r\n\r\n- [ ] first\r\n- [x] second\r\n\r\n| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\nTerm\r\n: Definition\r\n\r\nText[^note].\r\n\r\n[^note]: Note';
    const model = await parseMarkdown(source);
    const tags = elements(model.children).map((node) => node.tagName);
    expect(tags).toEqual(expect.arrayContaining(['table', 'dl', 'dt', 'dd', 'input', 'sup']));
    expect(model.tasks).toHaveLength(2);
    for (const task of model.tasks) expect(source[task.offset]).toBe(task.checked ? 'x' : ' ');
    expect(
      elements(model.children)
        .filter((node) => node.tagName === 'input')
        .map((node) => node.properties.dataQuillTask),
    ).toEqual(['task-0', 'task-1']);
    const footnote = elements(model.children).find(
      (node) => node.tagName === 'a' && String(node.properties.href).includes('fn-note'),
    );
    expect(footnote?.properties.href).toBe('#quill-user-content-fn-note');
  });

  it('supports YAML and TOML metadata without exposing aliases or duplicate keys', async () => {
    const yaml = await parseMarkdown('---\ntitle: Sample\nbibliography: refs.bib\n---\n# Body');
    expect(yaml.metadata).toEqual({ title: 'Sample', bibliography: 'refs.bib' });
    expect(content(yaml.children)).toBe('Body');
    expect((await parseMarkdown('+++\ntitle = "Test"\n+++\nBody')).metadata).toEqual({
      title: 'Test',
    });
    expect((await parseMarkdown('---\nx: &a [1]\ny: *a\n---\nBody')).warnings).toContain(
      'metadata_invalid',
    );
    expect((await parseMarkdown('---\nx: 1\nx: 2\n---\nBody')).warnings).toContain(
      'metadata_invalid',
    );
  });

  it('keeps wiki aliases, embed heading/block selectors and citations distinct', async () => {
    const source = '[[Note#Heading|Alias]] ![[Other#^block]] [@doe2024; @smith2025, p. 2]';
    const model = await parseMarkdown(source);
    expect(model.references.map(({ kind, target, label }) => ({ kind, target, label }))).toEqual([
      { kind: 'link', target: 'Note#Heading', label: 'Alias' },
      { kind: 'embed', target: 'Other#^block', label: 'Other#^block' },
      { kind: 'citation', target: 'doe2024', label: '@doe2024' },
      { kind: 'citation', target: 'smith2025', label: '@smith2025, p. 2' },
    ]);
    expect(
      elements(model.children).filter((node) => node.properties.dataQuillReference),
    ).toHaveLength(4);
    expect(
      (await parseMarkdown('`[[code]]` \\[[escaped]] [link](https://example.test)')).references,
    ).toHaveLength(0);
    const withEntity = 'Fish &amp; chips [[Note]]';
    expect((await parseMarkdown(withEntity)).references[0]?.offset).toBe(withEntity.indexOf('[['));
  });

  it('renders callouts, block references, formatting and emoji without directives', async () => {
    const model = await parseMarkdown(
      '> [!TIP]- Custom title\n> Body\n\n==mark== H~2~O x^2^ :smile:\n\nParagraph ^my-block\n\n:::note\nNot a directive\n:::',
    );
    const nodes = elements(model.children);
    expect(nodes.find((node) => node.tagName === 'blockquote')?.properties).toMatchObject({
      dataCallout: 'tip',
      dataCalloutFold: '-',
      dataCalloutTitle: 'Custom title',
    });
    expect(nodes.map((node) => node.tagName)).toEqual(
      expect.arrayContaining(['mark', 'sub', 'sup']),
    );
    expect(nodes.find((node) => node.properties.id === 'quill-block-my-block')).toBeDefined();
    expect(content(model.children)).not.toContain('^my-block');
    expect(content(model.children)).toContain(':::note');
    expect(content(model.children)).toContain('😄');
  });

  it('keeps predictable heading ids and code metadata with syntax coloring', async () => {
    const model = await parseMarkdown(
      '# A heading\n\n# A heading\n\n```js title="example.js" showLineNumbers {1,3-5}\nconst answer = 42;\n```\n\n```mermaid\ngraph TD; A-->B;\n```',
    );
    expect(model.headings.map((heading) => heading.id)).toEqual([
      'quill-heading-a-heading',
      'quill-heading-a-heading-1',
    ]);
    const code = elements(model.children).find(
      (node) => node.tagName === 'code' && node.properties.dataLanguage === 'js',
    );
    expect(code?.properties).toMatchObject({
      dataFilename: 'example.js',
      dataLineNumbers: true,
      dataHighlightLines: '1,3-5',
    });
    expect(
      code &&
        elements(code.children).some((node) => String(node.properties.className).includes('hljs')),
    ).toBe(true);
    expect(
      elements(model.children).find((node) => node.properties.dataMermaid)?.properties.dataMermaid,
    ).toBe('graph TD; A-->B;');
  });

  it('renders math and chemistry without enabling KaTeX trusted commands', async () => {
    const model = await parseMarkdown(
      '$x^2$\n\n$$\n\\ce{H2O}\n$$\n\n$\\href{javascript:alert(1)}{bad}$',
    );
    const nodes = elements(model.children);
    expect(
      nodes.filter((node) => String(node.properties.className).split(',').includes('katex')).length,
    ).toBeGreaterThanOrEqual(2);
    expect(nodes.some((node) => node.tagName === 'math')).toBe(true);
    expect(nodes.some((node) => String(node.properties.href).includes('javascript:'))).toBe(false);
  });

  it('sanitizes HTML, event handlers, active embeds, styles and DOM clobbering', async () => {
    const model = await parseMarkdown(
      '<script>alert(1)</script>\n\n<iframe src="https://evil.test"></iframe>\n\n<img src="javascript:alert(1)" onerror="alert(1)" style="position:fixed" width="200">\n\n<a id="location" href="javascript:alert(1)">bad</a>\n\n<details open><summary>Summary</summary><kbd>Ctrl</kbd><sup>2</sup></details>',
    );
    const nodes = elements(model.children);
    expect(
      nodes.some((node) => ['script', 'iframe', 'object', 'embed'].includes(node.tagName)),
    ).toBe(false);
    expect(
      nodes.some((node) =>
        Object.keys(node.properties).some((key) => /^on/i.test(key) || key === 'style'),
      ),
    ).toBe(false);
    expect(nodes.find((node) => node.tagName === 'a')?.properties).toEqual({
      id: 'quill-location',
    });
    expect(nodes.find((node) => node.tagName === 'details')?.properties.open).toBe(true);
    expect(nodes.find((node) => node.tagName === 'img')?.properties.width).toBe(200);
  });

  it('bounds source bytes and structural depth', async () => {
    await expect(parseMarkdown('a'.repeat(QUILL_LIMITS.sourceBytes + 1))).rejects.toThrow(
      'markdown_limit',
    );
    await expect(parseMarkdown(`${'> '.repeat(140)}deep`)).rejects.toThrow('markdown_limit');
  });
});

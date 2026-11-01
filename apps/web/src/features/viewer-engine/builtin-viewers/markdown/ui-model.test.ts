import { describe, expect, it } from 'vitest';
import type { QuillModel } from './model.js';
import {
  createQuillEmbedBudget,
  quillAnchorIds,
  quillDiagramSourceAllowed,
  quillSearchRanges,
} from './ui-model.js';

describe('Quill UI boundaries', () => {
  it('rejects asset and configuration constructs before Mermaid can perform layout or requests', () => {
    expect(quillDiagramSourceAllowed('flowchart LR\n A-->B')).toBe(true);
    for (const source of [
      'flowchart LR\n A@{ img: "https://tracker.example/pixel", label: "x" }',
      'sequenceDiagram\n participant A\n properties A: {"icon":"https://tracker.example/a"}',
      'sequenceDiagram;details A: {"properties":{"icon":"https://tracker.example/a"}}',
      '%%{init: {"themeCSS":"body {background:url(https://tracker.example)}"}}%%\nflowchart LR\nA-->B',
      'flowchart LR\n style A fill:url(https://tracker.example/a)',
      'flowchart LR\n A["<img src=https://tracker.example/a>"]',
    ])
      expect(quillDiagramSourceAllowed(source)).toBe(false);
  });
  it('keeps Unicode search offsets within the original text', () => {
    expect(quillSearchRanges('İi İ 😀', 'i')).toEqual([{ start: 1, end: 2 }]);
    expect(quillSearchRanges('İi İ 😀', 'İ')).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
    expect(quillSearchRanges('İi İ 😀', '😀')).toEqual([{ start: 5, end: 7 }]);
    expect(quillSearchRanges('[a]. [a].', '[a].')).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ]);
  });
  it('resolves heading, block and footnote IDs inside the inclusion namespace', () => {
    const model: QuillModel = {
      children: [],
      headings: [{ id: 'quill-heading-install', text: 'Install', depth: 2, offset: 0 }],
      metadata: null,
      references: [],
      tasks: [],
      warnings: [],
    };
    expect(quillAnchorIds(model, 'root-embed-1', 'Install')).toContain(
      'root-embed-1-quill-heading-install',
    );
    expect(quillAnchorIds(model, 'root-embed-1', '^block')).toContain(
      'root-embed-1-quill-block-block',
    );
    expect(quillAnchorIds(model, 'root-embed-1', 'quill-user-content-fn-1')).toContain(
      'root-embed-1-quill-user-content-fn-1',
    );
    expect(quillAnchorIds(model, 'root-embed-1', '100%')).toContain('root-embed-1-100%');
    expect(
      quillAnchorIds(model, 'root-embed-1', 'Install').every((id) =>
        id.startsWith('root-embed-1-'),
      ),
    ).toBe(true);
  });
  it('caps occurrences even if every inclusion uses the same cached source', () => {
    const budget = createQuillEmbedBudget();
    budget.claimed.add('same-source.md');
    for (let i = 0; i < 16; i++) expect(budget.acquire(`embed-${i}`)).toBe(true);
    expect(budget.acquire('embed-17')).toBe(false);
    budget.release('embed-0');
    expect(budget.acquire('embed-17')).toBe(true);
  });
  it('charges rendered nodes for every repeated inclusion and releases on unmount', () => {
    const budget = createQuillEmbedBudget();
    expect(budget.acquire('a')).toBe(true);
    expect(budget.acquire('b')).toBe(true);
    expect(budget.render('a', 30_000)).toBe(true);
    expect(budget.render('b', 30_000)).toBe(false);
    budget.release('a');
    expect(budget.render('b', 30_000)).toBe(true);
    expect(budget.render('missing', 1)).toBe(false);
  });
});

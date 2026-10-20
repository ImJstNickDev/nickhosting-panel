import { describe, expect, it } from 'vitest';
import { parseModDescription } from './mods-description.js';

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
});

import { describe, expect, it } from 'vitest';
import { fileLanguage, validateFileSyntax } from './file-editor-model.js';

describe('file editor language and syntax', () => {
  it.each([
    ['/data/settings.JSON', 'json'],
    ['/settings.yml', 'yaml'],
    ['/config.toml', 'toml'],
    ['/server.properties', 'properties'],
    ['/bootstrap.ts', 'typescript'],
    ['/bootstrap.mjs', 'javascript'],
    ['/setup.py', 'python'],
    ['/start.sh', 'shell'],
    ['/readme.txt', 'text'],
    ['/a.json/file', 'text'],
  ])('selects syntax for %s', (path, language) => expect(fileLanguage(path)).toBe(language));
  it('validates JSON and reports the failing line', () => {
    expect(validateFileSyntax('a.json', '{"safe": true}')).toEqual([]);
    expect(validateFileSyntax('a.json', '{\n"a": ,\n}')).toEqual([{ from: 7, to: 8, line: 2 }]);
  });
  it('validates YAML without resolving aliases or remote custom tags', () => {
    expect(validateFileSyntax('a.yaml', 'root: &root [*root]\n')).toEqual([]);
    expect(validateFileSyntax('a.yaml', 'remote: !custom https://example.invalid/schema')).toEqual(
      [],
    );
    expect(validateFileSyntax('a.yaml', 'a: 1\na: 2')).toHaveLength(1);
    expect(validateFileSyntax('a.yaml', 'a: [')).toHaveLength(1);
  });
  it('rejects invalid or duplicate TOML keys', () => {
    expect(validateFileSyntax('a.toml', '[server]\nport = 25565')).toEqual([]);
    expect(validateFileSyntax('a.toml', 'port = 1\nport = 2')).toHaveLength(1);
    expect(validateFileSyntax('a.toml', 'port = ')).toHaveLength(1);
  });
  it('does not claim syntax validation for scripts, properties or plain text', () => {
    for (const path of ['server.properties', 'run.sh', 'script.js', 'readme.txt']) {
      expect(validateFileSyntax(path, 'invalid? arbitrary contents')).toBeUndefined();
    }
  });
});

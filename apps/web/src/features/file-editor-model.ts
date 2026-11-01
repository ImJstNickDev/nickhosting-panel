import { jsonLanguage } from '@codemirror/lang-json';
import { parse as parseToml, TomlError } from 'smol-toml';
import { parseDocument } from 'yaml';

export type FileLanguage =
  | 'json'
  | 'yaml'
  | 'toml'
  | 'properties'
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'shell'
  | 'text';

export function fileLanguage(path: string): FileLanguage {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  const extension = name.split('.').at(-1);
  if (extension === 'json') return 'json';
  if (extension === 'yaml' || extension === 'yml') return 'yaml';
  if (extension === 'toml') return 'toml';
  if (extension === 'properties' || extension === 'ini' || extension === 'cfg') return 'properties';
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension ?? '')) return 'javascript';
  if (['ts', 'tsx', 'mts', 'cts'].includes(extension ?? '')) return 'typescript';
  if (extension === 'py') return 'python';
  if (['sh', 'bash', 'zsh'].includes(extension ?? '') || name === '.bashrc') return 'shell';
  return 'text';
}

export type FileSyntaxIssue = { from: number; to: number; line: number };

/** Syntax only. Never evaluates scripts, resolves YAML aliases or loads remote schemas. */
export function validateFileSyntax(path: string, content: string): FileSyntaxIssue[] | undefined {
  const language = fileLanguage(path);
  if (!['json', 'yaml', 'toml'].includes(language)) return undefined;
  const issue = (offset: number): FileSyntaxIssue => {
    const from = Math.max(0, Math.min(content.length, offset));
    return {
      from,
      to: Math.min(content.length, from + 1),
      line: content.slice(0, from).split('\n').length,
    };
  };
  if (language === 'yaml') {
    // Parse the syntax tree only: toJS would unnecessarily expand user-controlled aliases.
    return parseDocument(content, { prettyErrors: false, uniqueKeys: true })
      .errors.slice(0, 50)
      .map((error) => issue(error.pos[0]));
  }
  try {
    if (language === 'json') JSON.parse(content);
    else parseToml(content);
    return [];
  } catch (error) {
    if (error instanceof TomlError) {
      const lines = content.split('\n');
      const preceding = lines
        .slice(0, Math.max(0, error.line - 1))
        .reduce((sum, line) => sum + line.length + 1, 0);
      return [issue(preceding + Math.max(0, error.column - 1))];
    }
    const position = error instanceof SyntaxError ? /position (\d+)/.exec(error.message) : null;
    if (position) return [issue(Number(position[1]))];
    let firstError: number | undefined;
    jsonLanguage.parser.parse(content).iterate({
      enter(node) {
        if (node.type.isError && firstError === undefined) firstError = node.from;
      },
    });
    return [issue(firstError ?? 0)];
  }
}

export const editorPhraseKeys: Record<string, string> = {
  Find: 'search',
  Replace: 'replace',
  next: 'next',
  previous: 'previous',
  all: 'all',
  'match case': 'matchCase',
  regexp: 'regexp',
  'by word': 'byWord',
  replace: 'replace',
  'replace all': 'replaceAll',
  close: 'close',
  'Go to line': 'goToLine',
  go: 'go',
  'current match': 'currentMatch',
  'on line': 'onLine',
  'replaced match on line $': 'replacedLine',
  'replaced $ matches': 'replacedMatches',
  Diagnostics: 'diagnostics',
  'No diagnostics': 'noDiagnostics',
  'Control character': 'controlCharacter',
};

export interface QuillElement {
  type: 'element';
  tagName: string;
  properties: Record<string, string | number | boolean | string[] | undefined>;
  children: QuillNode[];
  start?: number;
  end?: number;
}

export type QuillNode =
  | QuillElement
  | {
      type: 'text';
      value: string;
      start?: number;
      end?: number;
    };

export interface QuillReference {
  id: string;
  kind: 'link' | 'embed' | 'citation';
  target: string;
  label: string;
  offset: number;
}

export interface QuillModel {
  children: QuillNode[];
  headings: { id: string; text: string; depth: number; offset: number }[];
  metadata: Record<string, unknown> | null;
  references: QuillReference[];
  tasks: { id: string; offset: number; checked: boolean }[];
  warnings: string[];
}

export const QUILL_LIMITS = {
  sourceBytes: 1_048_576,
  nodes: 50_000,
  depth: 128,
  metadataBytes: 65_536,
  references: 2_000,
} as const;

/** Matches Markdown heading fragments, including Obsidian's original heading text. */
export function quillHeadingSlug(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

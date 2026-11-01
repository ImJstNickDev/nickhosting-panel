/** Only bounded windows cross the worker boundary, except explicit clipboard requests. */
export interface JsonRow {
  id: number;
  index: number;
  parentId: number | null;
  key?: string;
  keyTruncated: boolean;
  kind: string;
  preview: string;
  previewTruncated: boolean;
  depth: number;
  childCount: number;
  expanded: boolean;
  selected: boolean;
  matched: boolean;
  position: number;
  setSize: number;
}

export interface JsonView {
  rows: JsonRow[];
  totalVisible: number;
  totalNodes: number;
  offset: number;
  selectedId: number;
  selectedIndex: number;
  matchCount: number;
  /** Zero based; -1 when no match is active. */
  matchIndex: number;
}

export interface JsonDetail {
  id: number;
  kind: string;
  pointer: string;
  pointerTruncated: boolean;
  pointerAmbiguous: boolean;
  raw: string;
  decoded?: string;
  decodedOffset?: number;
  decodedTotalLength?: number;
  /** Offsets and lengths use UTF-16 code units. Chunk boundaries never split a surrogate
   * pair; request the next chunk at offset + raw.length (decodedOffset + decoded.length). */
  offset: number;
  totalLength: number;
  line: number;
  column: number;
  childCount: number;
}

export type JsonAction =
  | { type: 'revealPosition'; offset: number }
  | { type: 'toggle' | 'select' | 'expand' | 'collapse'; id: number }
  | { type: 'move'; direction: 'next' | 'previous' | 'first' | 'last' | 'parent' | 'child' }
  | { type: 'collapseAll' }
  | { type: 'search'; query: string }
  | { type: 'match'; direction: 1 | -1 };

export type JsonCopyKind = 'pointer' | 'value' | 'subtree' | 'decoded';
export type JsonRequest =
  | { type: 'load'; text: string; extension: string }
  | { type: 'view'; offset: number; limit: number }
  | { type: 'action'; action: JsonAction }
  | { type: 'detail'; id: number; offset: number; limit: number }
  | { type: 'copy'; id: number; kind: JsonCopyKind };

export type JsonErrorCode =
  | 'viewer.jsonInvalid'
  | 'viewer.jsonUnavailable'
  | 'viewer.jsonComplex'
  | 'viewer.jsonTimeout'
  | 'viewer.jsonTooLarge';
export interface JsonFailure {
  code: JsonErrorCode;
  line?: number;
  column?: number;
}
export type JsonResponse =
  | { requestId: number; result: JsonView | JsonDetail | string }
  | { requestId: number; error: JsonFailure };

export const jsonWindowLimits = {
  rows: 200,
  key: 160,
  preview: 240,
  detail: 16_384,
  pointer: 4096,
} as const;

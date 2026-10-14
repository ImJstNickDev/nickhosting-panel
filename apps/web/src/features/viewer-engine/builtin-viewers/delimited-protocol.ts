import { previewLimits } from '../core/limits.js';

export type DelimitedDelimiter = ',' | ';' | '\t' | '|';
export interface DelimitedOptions {
  delimiter: 'auto' | DelimitedDelimiter;
  header: 'auto' | boolean;
}
export interface DelimitedView {
  query?: string;
  column?: number;
  sort?: { column: number; direction: 'asc' | 'desc' };
  offset?: number;
  limit?: number;
}
export interface DelimitedPage {
  revision: number;
  delimiter: DelimitedDelimiter;
  newline: string;
  header: boolean;
  columns: string[];
  rows: { id: number; cells: string[] }[];
  total: number;
  offset: number;
  sourceRows: number;
  truncatedCells: boolean;
}
export type DelimitedEdit =
  | { type: 'set-cell'; rowId: number; column: number; value: string }
  | { type: 'insert-row'; beforeId?: number; cells?: string[] }
  | { type: 'remove-row'; rowId: number }
  | { type: 'insert-column'; column: number; name?: string }
  | { type: 'remove-column'; column: number }
  | { type: 'rename-header'; column: number; value: string };
export interface DelimitedEditResult {
  text: string;
  page: DelimitedPage;
}
export type DelimitedErrorCode = 'syntax' | 'limit' | 'stale' | 'disposed' | 'timeout' | 'invalid';
export class DelimitedError extends Error {
  constructor(readonly code: DelimitedErrorCode) {
    super(code);
    this.name = 'DelimitedError';
  }
}
export type DelimitedRequest =
  | { type: 'load'; text: string; extension: string; options: DelimitedOptions }
  | { type: 'view'; view: DelimitedView }
  | { type: 'detail'; rowId: number; column: number; revision?: number }
  | { type: 'edit'; op: DelimitedEdit; revision: number; view?: DelimitedView };
export type DelimitedResponse =
  | { requestId: number; result: DelimitedPage | DelimitedEditResult | string }
  | { requestId: number; error: DelimitedErrorCode };
export const delimitedLimits = {
  bytes: previewLimits.textBytes,
  rows: 50_000,
  cells: 100_000,
  columns: 128,
  page: 100,
  preview: 256,
  deadlineMs: 5000,
} as const;

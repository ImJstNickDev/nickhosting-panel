/** UTF-16 offset in the exact shared source, before CodeMirror newline normalization. */
export interface DocumentPosition {
  offset: number;
}

/** Trusted alternate views share the host's draft, save revision and authorization. */
export interface DocumentViewControls {
  pendingChanges?: boolean;
  focus(): void;
  getPosition?(): DocumentPosition | undefined | Promise<DocumentPosition | undefined>;
  revealPosition?(position: DocumentPosition): void | Promise<void>;
  flush?(): Promise<boolean>;
  find?(): void;
}
export interface DocumentViewProps {
  path: string;
  value: string;
  active: boolean;
  readOnly: boolean;
  resources?: DocumentResources;
  initialFragment?: string;
  /** Refuses a result calculated from a superseded draft. Never persists by itself. */
  onChange(value: string, expected: string): boolean;
  onSave(): void;
  onControls(controls: DocumentViewControls | undefined): void;
}

import type { DocumentResources } from './document-resources.js';

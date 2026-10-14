/** Trusted alternate views share the host's draft, save revision and authorization. */
export interface DocumentViewControls {
  pendingChanges?: boolean;
  focus(): void;
  flush?(): Promise<boolean>;
  find?(): void;
}
export interface DocumentViewProps {
  path: string;
  value: string;
  active: boolean;
  readOnly: boolean;
  /** Refuses a result calculated from a superseded draft. Never persists by itself. */
  onChange(value: string, expected: string): boolean;
  onSave(): void;
  onControls(controls: DocumentViewControls | undefined): void;
}

import type { UiField, UiSectionData } from '@nickhosting/game-sdk/ui';
import type { ReactNode } from 'react';

/** Presentation only: the shared form retains authorization, validation and durable jobs. */
export interface GameFormViewProps {
  fields: UiField[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  data: UiSectionData;
  serverName: string;
  disabled: boolean;
  dirty: boolean;
  onChange(id: string, value: unknown): void;
  feedback: ReactNode;
  actions: ReactNode;
}

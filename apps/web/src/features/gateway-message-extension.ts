import type { GatewayMessageDefinition } from '@nickhosting/game-sdk';

/** Browser-only contract. API metadata can never supply executable editors. */
export interface GatewayMessageExtensionProps {
  definition: GatewayMessageDefinition;
  state: GatewayMessageDefinition['states'][number];
  locale: 'en' | 'it';
  overrides: Record<string, string>;
  readOnly: boolean;
  onChange(channel: string, value: string): void;
  onReset(channel: string): void;
}

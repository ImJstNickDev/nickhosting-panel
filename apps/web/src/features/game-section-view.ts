import type { UiSectionData } from '@nickhosting/game-sdk/ui';

/** Bundled integration presentation; Core retains access and durable operation tracking. */
export interface GameSectionViewProps {
  data: UiSectionData;
  serverId: string;
  serverName: string;
  runtimeState: string;
  canManage: boolean;
  pending: boolean;
  onAccepted(jobId: string): void;
  reload(): Promise<unknown>;
}

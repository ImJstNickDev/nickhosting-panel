import type { UiSectionData } from '@nickhosting/game-sdk/ui';

/** Bundled integration presentation; Core retains access and durable operation tracking. */
export interface GameSectionViewProps {
  data: UiSectionData;
  serverId: string;
  serverName: string;
  runtimeState: string;
  canManage: boolean;
  pending: boolean;
  operation?: { state: string; effectState: string | null };
  /** Actual acknowledged transfer totals from the durable operation, when available. */
  fileTransfer?: {
    completedFiles: number;
    totalFiles: number;
    completedBytes: number;
    totalBytes: number;
  };
  onAccepted(jobId: string): void;
  reload(): Promise<unknown>;
}

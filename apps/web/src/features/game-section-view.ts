import type { UiSectionData } from '@nickhosting/game-sdk/ui';

export interface GameSectionAcceptedOptions {
  /** Apply only after the durable job confirms its external effect. */
  confirmedUpdate?: (current: UiSectionData) => UiSectionData;
  /** Short-lived fast observation for a small interactive operation. */
  quickCompletion?: boolean;
}

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
  onAccepted(jobId: string, options?: GameSectionAcceptedOptions): void;
  reload(): Promise<unknown>;
}

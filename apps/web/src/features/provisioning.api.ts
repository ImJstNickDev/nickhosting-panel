export type ProvisioningStage = 'preparing' | 'installing' | 'configuring' | 'starting' | 'ready';
export interface ProvisioningSnapshot {
  jobId: string;
  action: 'provision' | 'reinstall';
  stage: ProvisioningStage;
  state: 'active' | 'completed' | 'failed' | 'uncertain' | 'start-denied';
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  canReinstall: boolean;
  stages: Array<{
    id: ProvisioningStage;
    state: 'pending' | 'active' | 'completed' | 'failed';
    startedAt?: string;
    completedAt?: string;
  }>;
  logs: Array<{ id: string; at: string; text: string }>;
  logsAvailable: boolean;
  workflow?: {
    titleKey: string;
    statusKey: string;
    phaseKey: string;
    review: { sectionId: string; labelKey: string };
  };
}

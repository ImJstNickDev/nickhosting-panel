import type { ViewerSource } from './registry.js';
export interface ViewerProps {
  source: ViewerSource;
  serverId: string;
  identity: string;
  archiveDirectory?: string;
  onOpen: (source: ViewerSource) => void;
}

import type { ViewerSource } from './registry.js';
export interface ArchiveExtraction {
  entries?: string[];
  archives?: string[];
}
export interface ViewerProps {
  source: ViewerSource;
  serverId: string;
  identity: string;
  archiveDirectory?: string;
  onArchiveDirectory?: (directory: string) => void;
  onArchiveBack?: () => void;
  onExtract?: (selection?: ArchiveExtraction) => void;
  chrome?: { search: HTMLElement | null; view: HTMLElement | null; tools?: HTMLElement | null };
  listingView?: 'list' | 'grid';
  onListingView?: (view: 'list' | 'grid') => void;
  onOpenWith?: (source: ViewerSource) => void;
  onOpen: (source: ViewerSource) => void;
}

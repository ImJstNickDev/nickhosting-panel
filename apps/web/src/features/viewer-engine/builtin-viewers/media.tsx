import { viewerPath } from '../core/access.js';
import type { ViewerProps } from '../core/types.js';
import AudioViewer from './audio.js';
import VideoViewer from './video.js';

export default function MediaViewer(props: ViewerProps & { kind: 'audio' | 'video' }) {
  return props.kind === 'audio' ? (
    <AudioViewer key={viewerPath(props.serverId, props.source)} {...props} />
  ) : (
    <VideoViewer key={viewerPath(props.serverId, props.source)} {...props} />
  );
}

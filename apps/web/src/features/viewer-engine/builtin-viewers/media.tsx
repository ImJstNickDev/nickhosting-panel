import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import { viewerPath } from '../core/access.js';
import type { ViewerProps } from '../core/types.js';
import AudioViewer from './audio.js';

export default function MediaViewer(props: ViewerProps & { kind: 'audio' | 'video' }) {
  return props.kind === 'audio' ? (
    <AudioViewer key={viewerPath(props.serverId, props.source)} {...props} />
  ) : (
    <NativeVideo {...props} />
  );
}

function NativeVideo({ serverId, source }: ViewerProps) {
  const t = useT();
  const ref = useRef<HTMLMediaElement | null>(null);
  const [failed, setFailed] = useState(false);
  const src = viewerPath(serverId, source);
  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    // StrictMode replays cleanup/setup; restore the source as well as releasing it.
    if (media.getAttribute('src') !== src) media.setAttribute('src', src);
    return () => {
      media.pause();
      media.removeAttribute('src');
      media.load();
    };
  }, [src]);
  const props = {
    src,
    controls: true,
    preload: 'metadata',
    onError: () => setFailed(true),
    'aria-label': source.name,
  } as const;
  return (
    <div className="ve-media ve-video">
      {failed ? (
        <ErrorNotice error={{ messageKey: 'viewer.mediaUnsupported' }} />
      ) : (
        <video
          {...props}
          ref={(element) => {
            ref.current = element;
          }}
          playsInline
        />
      )}
      <span className="sr-only">{t('viewer.video')}</span>
    </div>
  );
}

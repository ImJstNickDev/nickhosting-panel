import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { ErrorNotice } from '../../../components/ui.js';
import { viewerPath } from '../core/access.js';
import type { ViewerProps } from '../core/types.js';

export default function MediaViewer({
  serverId,
  source,
  kind,
}: ViewerProps & { kind: 'audio' | 'video' }) {
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
    <div className={`ve-media ve-${kind}`}>
      {failed ? (
        <ErrorNotice error={{ messageKey: 'viewer.mediaUnsupported' }} />
      ) : kind === 'video' ? (
        <video
          {...props}
          ref={(element) => {
            ref.current = element;
          }}
          playsInline
        />
      ) : (
        <audio
          {...props}
          ref={(element) => {
            ref.current = element;
          }}
        />
      )}
      <span className="sr-only">{t(`viewer.${kind}`)}</span>
    </div>
  );
}

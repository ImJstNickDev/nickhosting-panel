import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useT } from '../../../app/i18n.js';
import { AudioWaveform } from './audio-waveform.js';

const clock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const value = Math.floor(seconds),
    hours = Math.floor(value / 3600);
  return `${hours ? `${hours}:` : ''}${String(Math.floor(value / 60) % 60).padStart(hours ? 2 : 1, '0')}:${String(value % 60).padStart(2, '0')}`;
};

/** The playback clock updates this subtree only, never the transport controls. */
export function AudioTimeline({
  media,
  onDuration,
  src,
  size,
  duration,
  seekable,
  paused,
  failed,
}: {
  media: RefObject<HTMLAudioElement | null>;
  onDuration: (duration: number) => void;
  src: string;
  size: number;
  duration: number;
  seekable: boolean;
  paused: boolean;
  failed: boolean;
}) {
  const t = useT();
  const [time, setTime] = useState(0);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const scrubbing = useRef(false);
  const sync = useCallback(() => {
    if (media.current) setTime(media.current.currentTime);
  }, [media]);
  useLayoutEffect(() => {
    const audio = media.current;
    if (!audio) return;
    const events = ['timeupdate', 'seeking', 'seeked', 'loadedmetadata', 'ended', 'emptied'];
    for (const event of events) audio.addEventListener(event, sync);
    sync();
    return () => {
      for (const event of events) audio.removeEventListener(event, sync);
    };
  }, [media, sync]);
  useLayoutEffect(() => {
    sync();
    if (paused || failed) return;
    let frame = 0;
    const update = () => {
      sync();
      if (media.current && !media.current.paused && !media.current.ended)
        frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [paused, failed, media, sync]);
  function seek(value: number) {
    if (!media.current || !seekable) return;
    media.current.currentTime = Math.max(0, Math.min(duration, value));
    sync();
  }
  function finishScrub(value: number) {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    seek(value);
    setSeekDraft(null);
  }
  function cancelScrub() {
    scrubbing.current = false;
    setSeekDraft(null);
  }
  const displayedTime = seekDraft ?? Math.max(0, Math.min(duration || Infinity, time));
  return (
    <div className="wave-timeline">
      <div className="wave-seek">
        <AudioWaveform
          url={src}
          size={size}
          duration={duration}
          onDuration={onDuration}
          position={displayedTime}
          unavailable={failed}
        />
        <input
          className="wave-range wave-seek-input"
          type="range"
          aria-label={t('viewer.audioPosition')}
          aria-valuetext={t('viewer.audioTime', {
            current: clock(displayedTime),
            total: duration ? clock(duration) : '—',
          })}
          min={0}
          max={duration || 1}
          step={0.001}
          value={displayedTime}
          disabled={!seekable}
          style={
            {
              '--wave-progress': `${duration ? (displayedTime / duration) * 100 : 0}%`,
            } as CSSProperties
          }
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            scrubbing.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (scrubbing.current) setSeekDraft(value);
            else seek(value);
          }}
          onPointerUp={(event) => finishScrub(Number(event.currentTarget.value))}
          onBlur={(event) => finishScrub(Number(event.currentTarget.value))}
          onPointerCancel={cancelScrub}
          onLostPointerCapture={cancelScrub}
        />
      </div>
      <div className="wave-times" aria-hidden="true">
        <span>{clock(displayedTime)}</span>
        <span>{duration ? clock(duration) : '—'}</span>
      </div>
    </div>
  );
}

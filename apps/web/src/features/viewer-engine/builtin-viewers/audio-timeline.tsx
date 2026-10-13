import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useT } from '../../../app/i18n.js';
import { AudioPlaybackClock } from './audio-playback-clock.js';
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
  failed,
}: {
  media: RefObject<HTMLAudioElement | null>;
  onDuration: (duration: number) => void;
  src: string;
  size: number;
  duration: number;
  seekable: boolean;
  failed: boolean;
}) {
  const t = useT();
  const [time, setTime] = useState(0);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const scrubbing = useRef(false);
  const playbackClock = useRef(new AudioPlaybackClock());
  const sync = useCallback(() => {
    if (media.current)
      setTime(playbackClock.current.reset(media.current.currentTime, performance.now()));
  }, [media]);
  useLayoutEffect(() => {
    const audio = media.current;
    if (!audio) return;
    let frame = 0;
    let playing = false;
    const stop = () => {
      playing = false;
      cancelAnimationFrame(frame);
      frame = 0;
      sync();
    };
    const update = () => {
      frame = 0;
      if (!playing || audio.paused || audio.ended || audio.seeking) {
        stop();
        return;
      }
      setTime(
        playbackClock.current.sample(audio.currentTime, performance.now(), audio.playbackRate),
      );
      frame = requestAnimationFrame(update);
    };
    const start = () => {
      if (failed || document.hidden || audio.paused || audio.ended || audio.seeking) return;
      playing = true;
      sync();
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observe = () => {
      if (!playing) sync();
    };
    const reanchor = () => {
      sync();
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) start();
    };
    const visibility = () => {
      stop();
      if (!document.hidden && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) start();
    };
    const holds = ['pause', 'waiting', 'seeking', 'ended', 'emptied', 'error'];
    for (const event of holds) audio.addEventListener(event, stop);
    audio.addEventListener('playing', start);
    audio.addEventListener('seeked', reanchor);
    audio.addEventListener('ratechange', sync);
    audio.addEventListener('loadedmetadata', observe);
    audio.addEventListener('timeupdate', observe);
    document.addEventListener('visibilitychange', visibility);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      for (const event of holds) audio.removeEventListener(event, stop);
      audio.removeEventListener('playing', start);
      audio.removeEventListener('seeked', reanchor);
      audio.removeEventListener('ratechange', sync);
      audio.removeEventListener('loadedmetadata', observe);
      audio.removeEventListener('timeupdate', observe);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [failed, media, sync]);
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

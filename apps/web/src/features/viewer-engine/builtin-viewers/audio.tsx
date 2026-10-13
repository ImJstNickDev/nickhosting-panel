import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useFormat, useT } from '../../../app/i18n.js';
import { Tooltip } from '../../../components/tooltip.js';
import { ErrorNotice } from '../../../components/ui.js';
import { viewerPath } from '../core/access.js';
import type { ViewerProps } from '../core/types.js';
import { ViewerIcon } from '../viewer-icon.js';
import { ViewerSelect } from '../viewer-select.js';
import { AudioTimeline } from './audio-timeline.js';
import { waveformLimits } from './audio-waveform-model.js';
import './audio.css';

const initial = {
  duration: 0,
  paused: true,
  volume: 1,
  muted: false,
  rate: 1,
  ready: false,
};
const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];

export default function AudioViewer({ serverId, source }: ViewerProps) {
  const t = useT(),
    format = useFormat();
  const src = viewerPath(serverId, source);
  const media = useRef<HTMLAudioElement>(null);
  const generation = useRef(0);
  const lastVolume = useRef(1);
  const [state, setState] = useState(initial);
  const [decodedDuration, setDecodedDuration] = useState<number>();
  const [buffering, setBuffering] = useState(false);
  const [showBuffering, setShowBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playError, setPlayError] = useState(false);
  const [repeat, setRepeat] = useState(false);
  useEffect(() => {
    if (!buffering) {
      setShowBuffering(false);
      return;
    }
    // Brief decoder/seek transitions should not flash a loading announcement.
    // This delays only feedback; play() is never held behind the timer.
    const timer = window.setTimeout(() => setShowBuffering(true), 200);
    return () => window.clearTimeout(timer);
  }, [buffering]);
  const sync = useCallback(() => {
    const audio = media.current;
    if (!audio) return;
    const next = {
      duration: audio.duration,
      paused: audio.paused,
      volume: audio.volume,
      muted: audio.muted,
      rate: audio.playbackRate,
      ready: audio.readyState >= 1,
    };
    setState((previous) =>
      (Object.keys(next) as (keyof typeof next)[]).every((key) =>
        Object.is(previous[key], next[key]),
      )
        ? previous
        : next,
    );
  }, []);
  useEffect(() => {
    const audio = media.current;
    if (!audio) return;
    generation.current++;
    if (audio.getAttribute('src') !== src) audio.setAttribute('src', src);
    return () => {
      generation.current++;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [src]);
  async function toggle() {
    const audio = media.current;
    if (!audio) return;
    const attempt = ++generation.current;
    setPlayError(false);
    if (!audio.paused) {
      audio.pause();
      setBuffering(false);
      sync();
      return;
    }
    if (failed || !state.ready) return;
    try {
      const playing = audio.play();
      // paused changes synchronously; do not wait for the queued play event.
      sync();
      await playing;
    } catch (error) {
      if (generation.current !== attempt || (error as DOMException).name === 'AbortError') return;
      setBuffering(false);
      setPlayError(true);
      sync();
    }
  }
  const duration =
    decodedDuration ?? (Number.isFinite(state.duration) && state.duration > 0 ? state.duration : 0);
  const seekable = state.ready && duration > 0 && !failed;
  function seek(value: number) {
    const audio = media.current;
    if (!audio || !seekable) return;
    audio.currentTime = Math.max(0, Math.min(duration, value));
    sync();
  }
  function mute() {
    const audio = media.current;
    if (!audio) return;
    if (audio.muted || audio.volume === 0) {
      audio.muted = false;
      if (audio.volume === 0) audio.volume = lastVolume.current;
    } else audio.muted = true;
    sync();
  }
  function retry() {
    const audio = media.current;
    if (!audio) return;
    generation.current++;
    audio.pause();
    setFailed(false);
    setPlayError(false);
    setBuffering(false);
    setState((value) => ({ ...value, duration: 0, ready: false, paused: true }));
    audio.load();
  }
  const silent = state.muted || state.volume === 0;
  const extension = source.name.split('.').at(-1)?.toUpperCase();
  return (
    <div className="ve-wave">
      <div className="ve-audio-player">
        {/* biome-ignore lint/a11y/useMediaCaption: Arbitrary file preview; no transcript is supplied or fabricated. */}
        <audio
          ref={media}
          src={src}
          // Warm bounded previews before Play; avoid downloading large media
          // merely because its viewer was opened. Browsers may limit preloading.
          preload={source.size > 0 && source.size <= waveformLimits.bytes ? 'auto' : 'metadata'}
          hidden
          onLoadedMetadata={sync}
          onDurationChange={sync}
          onVolumeChange={sync}
          onRateChange={sync}
          onPlay={sync}
          onPlaying={() => {
            setBuffering(false);
            sync();
          }}
          onPause={() => {
            setBuffering(false);
            sync();
          }}
          onEnded={() => {
            setBuffering(false);
            sync();
          }}
          onWaiting={() => setBuffering(true)}
          onCanPlay={() => {
            setBuffering(false);
            sync();
          }}
          onSeeking={() => {
            if (!media.current?.paused) setBuffering(true);
            sync();
          }}
          onSeeked={() => {
            setBuffering(false);
            sync();
          }}
          onError={() => {
            setFailed(true);
            setBuffering(false);
            sync();
          }}
        />
        <div className="wave-heading">
          <span className="wave-mark">
            <ViewerIcon id="audio" />
          </span>
          <div className="wave-file">
            <strong>{source.name}</strong>
            <span>
              {extension} <span aria-hidden="true">·</span> {format.bytes(source.size)}
            </span>
          </div>
        </div>
        <AudioTimeline
          media={media}
          onDuration={setDecodedDuration}
          src={src}
          size={source.size}
          duration={duration}
          seekable={seekable}
          paused={state.paused}
          failed={failed}
        />
        <div className="wave-controls">
          <div className="wave-repeat">
            <AudioButton
              label={t('viewer.audioRepeat')}
              pressed={repeat}
              onClick={() => {
                if (media.current) media.current.loop = !repeat;
                setRepeat(!repeat);
              }}
            >
              <AudioIcon kind="repeat" />
            </AudioButton>
          </div>
          <div className="wave-transport">
            <AudioButton
              label={t('viewer.audioBack')}
              disabled={!seekable}
              onClick={() => seek((media.current?.currentTime ?? 0) - 10)}
            >
              <AudioIcon kind="back" />
            </AudioButton>
            <AudioButton
              label={t(state.paused ? 'viewer.audioPlay' : 'viewer.audioPause')}
              disabled={state.paused && (failed || !state.ready)}
              onClick={() => void toggle()}
              className="wave-play"
            >
              <AudioIcon kind={state.paused ? 'play' : 'pause'} />
            </AudioButton>
            <AudioButton
              label={t('viewer.audioForward')}
              disabled={!seekable}
              onClick={() => seek((media.current?.currentTime ?? 0) + 10)}
            >
              <AudioIcon kind="forward" />
            </AudioButton>
          </div>
          <div className="wave-speed">
            <ViewerSelect
              label={t('viewer.audioSpeed')}
              value={String(state.rate)}
              options={speeds.map((speed) => ({
                value: String(speed),
                label: `${format.number(speed, 2)}×`,
              }))}
              onChange={(value) => {
                if (media.current) media.current.playbackRate = Number(value);
                sync();
              }}
            />
          </div>
          <div className="wave-volume">
            <AudioButton
              label={t(silent ? 'viewer.audioUnmute' : 'viewer.audioMute')}
              onClick={mute}
            >
              <AudioIcon kind={silent ? 'mute' : 'volume'} />
            </AudioButton>
            <input
              className="wave-range"
              type="range"
              min={0}
              max={100}
              step={1}
              aria-label={t('viewer.audioVolume')}
              aria-valuetext={`${format.number(silent ? 0 : state.volume * 100, 0)}%`}
              value={silent ? 0 : state.volume * 100}
              style={{ '--wave-progress': `${silent ? 0 : state.volume * 100}%` } as CSSProperties}
              onChange={(event) => {
                const audio = media.current;
                if (!audio) return;
                const volume = Number(event.target.value) / 100;
                audio.volume = volume;
                audio.muted = volume === 0;
                if (volume > 0) lastVolume.current = volume;
                sync();
              }}
            />
          </div>
        </div>
        <div className="wave-feedback">
          {failed || playError ? (
            <div className="wave-error">
              <ErrorNotice
                error={{
                  messageKey: failed ? 'viewer.mediaUnsupported' : 'viewer.audioPlayFailed',
                }}
              />
              {failed && (
                <button className="text-button" type="button" onClick={retry}>
                  {t('viewer.audioRetry')}
                </button>
              )}
            </div>
          ) : (
            <span role="status">
              {!state.ready
                ? t('viewer.audioLoading')
                : buffering && showBuffering
                  ? t('viewer.audioBuffering')
                  : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function AudioButton({
  label,
  children,
  onClick,
  disabled,
  pressed,
  className = '',
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <Tooltip content={label}>
      <button
        className={`wave-button ${className}`}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}
function AudioIcon({
  kind,
}: {
  kind: 'play' | 'pause' | 'back' | 'forward' | 'repeat' | 'volume' | 'mute';
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'play' ? (
        <path d="m9 5 11 7-11 7z" fill="currentColor" stroke="none" />
      ) : kind === 'pause' ? (
        <path d="M8 5v14M16 5v14" strokeWidth="3.5" />
      ) : kind === 'back' || kind === 'forward' ? (
        <>
          <g transform={kind === 'forward' ? 'translate(24 0) scale(-1 1)' : undefined}>
            <path d="M5 8h7a8 8 0 0 1 8 8M5 8l4-4M5 8l4 4" />
          </g>
          <text
            x="11"
            y="21"
            textAnchor="middle"
            fill="currentColor"
            stroke="none"
            fontSize="10"
            fontWeight="600"
          >
            10
          </text>
        </>
      ) : kind === 'repeat' ? (
        <path d="M4 10V7h16m-3-3 3 3-3 3M20 14v3H4m3-3-3 3 3 3" />
      ) : (
        <>
          <path d="M4 9h4l5-4v14l-5-4H4z" />
          {kind === 'mute' ? (
            <path d="m17 9 5 6m0-6-5 6" />
          ) : (
            <path d="M17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14" />
          )}
        </>
      )}
    </svg>
  );
}

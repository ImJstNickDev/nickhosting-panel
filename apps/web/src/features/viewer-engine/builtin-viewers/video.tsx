import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useFormat, useLocale, useT } from '../../../app/i18n.js';
import { Tooltip } from '../../../components/tooltip.js';
import { ErrorNotice } from '../../../components/ui.js';
import { viewerPath } from '../core/access.js';
import type { ViewerProps } from '../core/types.js';
import { ViewerSelect } from '../viewer-select.js';
import { AudioPlaybackClock } from './audio-playback-clock.js';
import { useMediaShortcuts } from './media-shortcuts.js';
import { VideoIcon, type VideoIconKind } from './video-icons.js';
import { useVideoSource } from './video-source.js';
import { useVideoThumbnail } from './video-thumbnail.js';
import './video.css';

const initial = { duration: 0, paused: true, volume: 1, muted: false, rate: 1, ready: false };
const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
const clock = (seconds: number) => {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(value / 3600);
  return `${hours ? `${hours}:` : ''}${String(Math.floor(value / 60) % 60).padStart(hours ? 2 : 1, '0')}:${String(value % 60).padStart(2, '0')}`;
};

export default function VideoViewer({ serverId, source }: ViewerProps) {
  const t = useT(),
    format = useFormat();
  const src = viewerPath(serverId, source);
  const media = useRef<HTMLVideoElement>(null);
  const playback = useVideoSource({ media, url: src, size: source.size });
  const { locale } = useLocale();
  const stage = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const lifecycle = useRef(0);
  const lastVolume = useRef(1);
  const hideTimer = useRef(0);
  const gesture = useRef<{
    id: number;
    element: HTMLButtonElement;
    zone: 'left' | 'center' | 'right';
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const boost = useRef<{
    media: HTMLVideoElement | null;
    rate: number;
    owners: Set<'pointer' | 'space'>;
  }>({ media: null, rate: 1, owners: new Set() });
  const [state, setState] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [playError, setPlayError] = useState(false);
  const [displayError, setDisplayError] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [showWaiting, setShowWaiting] = useState(false);
  const [visible, setVisible] = useState(true);
  const [manuallyHidden, setManuallyHidden] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pip, setPip] = useState(false);
  const [displayPending, setDisplayPending] = useState(false);
  const duration = Number.isFinite(state.duration) && state.duration > 0 ? state.duration : 0;
  const seekable = state.ready && duration > 0 && !failed && !playback.switching;
  const silent = state.muted || state.volume === 0;
  const sync = useCallback(() => {
    const video = media.current;
    if (!video) return;
    const next = {
      duration: video.duration,
      paused: video.paused,
      volume: video.volume,
      muted: video.muted,
      rate: video.playbackRate,
      ready: video.readyState >= 1,
    };
    setState((previous) =>
      (Object.keys(next) as (keyof typeof next)[]).every((key) =>
        Object.is(previous[key], next[key]),
      )
        ? previous
        : next,
    );
  }, []);
  const startBoost = useCallback(
    (owner: 'pointer' | 'space') => {
      const video = media.current;
      if (
        playback.switching ||
        !video ||
        video.paused ||
        video.ended ||
        video.error ||
        video.readyState < 1
      )
        return;
      if (!boost.current.owners.size) {
        boost.current.media = video;
        boost.current.rate = video.playbackRate;
      }
      boost.current.owners.add(owner);
      video.playbackRate = 2;
      sync();
    },
    [sync, playback.switching],
  );
  const endBoost = useCallback(
    (owner: 'pointer' | 'space') => {
      if (!boost.current.owners.delete(owner) || boost.current.owners.size) return;
      if (boost.current.media) boost.current.media.playbackRate = boost.current.rate;
      boost.current.media = null;
      sync();
    },
    [sync],
  );
  const cancelGesture = useCallback(() => {
    const active = gesture.current;
    gesture.current = null;
    if (active?.element.hasPointerCapture(active.id))
      active.element.releasePointerCapture(active.id);
    endBoost('pointer');
  }, [endBoost]);
  const cancelBoosts = useCallback(() => {
    cancelGesture();
    endBoost('space');
  }, [cancelGesture, endBoost]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) cancelBoosts();
    };
    window.addEventListener('blur', cancelBoosts);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelBoosts();
      window.removeEventListener('blur', cancelBoosts);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [cancelBoosts]);
  const reveal = useCallback(() => {
    setManuallyHidden(false);
    setVisible(true);
    window.clearTimeout(hideTimer.current);
    const hide = () => {
      if (!media.current || media.current.paused) return;
      if (
        controls.current?.querySelector(':focus-visible, [aria-expanded="true"]') ||
        controls.current?.matches(':hover')
      ) {
        hideTimer.current = window.setTimeout(hide, 1000);
        return;
      }
      setVisible(false);
    };
    hideTimer.current = window.setTimeout(hide, 2600);
  }, []);
  useEffect(() => {
    reveal();
    if (state.paused) window.clearTimeout(hideTimer.current);
    return () => window.clearTimeout(hideTimer.current);
  }, [reveal, state.paused]);
  useEffect(() => {
    if (!waiting) {
      setShowWaiting(false);
      return;
    }
    const timer = window.setTimeout(() => setShowWaiting(true), 200);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  useEffect(() => {
    const video = media.current,
      root = stage.current;
    if (!video) return;
    generation.current++;
    lifecycle.current++;
    const display = () => {
      setFullscreen(document.fullscreenElement === root);
      setPip(document.pictureInPictureElement === video);
      reveal();
    };
    document.addEventListener('fullscreenchange', display);
    video.addEventListener('enterpictureinpicture', display);
    video.addEventListener('leavepictureinpicture', display);
    return () => {
      generation.current++;
      lifecycle.current++;
      document.removeEventListener('fullscreenchange', display);
      video.removeEventListener('enterpictureinpicture', display);
      video.removeEventListener('leavepictureinpicture', display);
      if (document.pictureInPictureElement === video)
        void document.exitPictureInPicture().catch(() => {});
      if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
    };
  }, [reveal]);
  useEffect(() => {
    if (playback.switching) {
      setFailed(false);
      setPlayError(false);
    }
  }, [playback.switching]);
  async function toggle() {
    const video = media.current;
    if (!video || playback.switching) return;
    reveal();
    const attempt = ++generation.current;
    setPlayError(false);
    if (!video.paused) {
      video.pause();
      setWaiting(false);
      sync();
      return;
    }
    if (failed || !state.ready || playback.switching) return;
    try {
      if (video.ended || (duration > 0 && video.currentTime >= duration - 0.001))
        video.currentTime = 0;
      const playing = video.play();
      sync();
      await playing;
    } catch (error) {
      if (generation.current !== attempt || (error as DOMException).name === 'AbortError') return;
      setWaiting(false);
      setPlayError(true);
      sync();
    }
  }
  function skip(seconds: number) {
    if (!media.current || !seekable) return;
    media.current.currentTime = Math.max(
      0,
      Math.min(duration, media.current.currentTime + seconds),
    );
    reveal();
  }
  useMediaShortcuts(() => void toggle(), skip, {
    isFocused: () => stage.current?.contains(document.activeElement) ?? false,
    startBoost: () => startBoost('space'),
    endBoost: () => endBoost('space'),
    fullscreen: () => {
      if (document.fullscreenEnabled) void changeDisplay('fullscreen');
    },
    mute,
  });
  function mute() {
    const video = media.current;
    if (!video || playback.switching) return;
    if (silent) {
      video.muted = false;
      if (!video.volume) video.volume = lastVolume.current;
    } else video.muted = true;
    sync();
  }
  function retry() {
    const video = media.current;
    if (!video) return;
    generation.current++;
    video.pause();
    setFailed(false);
    setPlayError(false);
    setWaiting(false);
    setState((value) => ({ ...value, duration: 0, ready: false, paused: true }));
    playback.retry();
  }
  async function changeDisplay(mode: 'fullscreen' | 'pip') {
    const video = media.current,
      root = stage.current;
    if (!video || !root || displayPending) return;
    const attempt = lifecycle.current;
    setDisplayError(false);
    setDisplayPending(true);
    reveal();
    try {
      if (mode === 'fullscreen') {
        if (document.fullscreenElement === root) await document.exitFullscreen();
        else await root.requestFullscreen();
      } else if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      if (lifecycle.current === attempt) setDisplayError(true);
    } finally {
      if (lifecycle.current === attempt) setDisplayPending(false);
    }
  }
  const controlsVisible =
    (!manuallyHidden && (visible || state.paused)) ||
    !state.ready ||
    waiting ||
    playback.switching ||
    Boolean(playback.error) ||
    failed ||
    playError ||
    displayError;
  return (
    <div
      className="motion-player"
      ref={stage}
      data-controls={controlsVisible ? 'visible' : 'hidden'}
      onPointerMove={(event) => {
        if (event.pointerType !== 'touch') reveal();
      }}
      onFocusCapture={(event) => {
        // Pointer focus on the stage must not undo its right-side hide gesture.
        if (!(event.target instanceof Element && event.target.matches('.motion-stage-toggle')))
          reveal();
      }}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: Arbitrary file preview; no captions are supplied or fabricated. */}
      <video
        ref={media}
        preload="metadata"
        playsInline
        aria-label={source.name}
        onLoadedMetadata={() => {
          setFailed(false);
          setPlayError(false);
          sync();
        }}
        onDurationChange={sync}
        onVolumeChange={sync}
        onRateChange={sync}
        onPlay={sync}
        onPlaying={() => {
          setWaiting(false);
          sync();
        }}
        onPause={() => {
          cancelBoosts();
          setWaiting(false);
          sync();
        }}
        onEnded={() => {
          cancelBoosts();
          setWaiting(false);
          sync();
        }}
        onWaiting={() => setWaiting(true)}
        onCanPlay={() => {
          setFailed(false);
          setWaiting(false);
          sync();
        }}
        onSeeking={() => {
          if (!media.current?.paused) setWaiting(true);
        }}
        onSeeked={() => {
          setWaiting(false);
          sync();
        }}
        onError={() => {
          cancelBoosts();
          setFailed(true);
          setWaiting(false);
          sync();
        }}
      />
      <button
        className="motion-stage-toggle"
        type="button"
        aria-label={t('viewer.videoGestures')}
        aria-expanded={controlsVisible}
        tabIndex={-1}
        onPointerDown={(event) => {
          if (event.button !== 0 || gesture.current) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const fraction = (event.clientX - bounds.left) / bounds.width;
          const zone = fraction < 0.2 ? 'left' : fraction >= 0.8 ? 'right' : 'center';
          gesture.current = {
            id: event.pointerId,
            element: event.currentTarget,
            zone,
            x: event.clientX,
            y: event.clientY,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          if (zone === 'left') startBoost('pointer');
        }}
        onPointerMove={(event) => {
          const active = gesture.current;
          if (
            active?.id === event.pointerId &&
            Math.hypot(event.clientX - active.x, event.clientY - active.y) > 8
          )
            active.moved = true;
        }}
        onPointerUp={(event) => {
          const active = gesture.current;
          if (active?.id !== event.pointerId) return;
          cancelGesture();
          if (active.moved) return;
          if (active.zone === 'center') void toggle();
          else if (active.zone === 'right') {
            window.clearTimeout(hideTimer.current);
            setVisible(false);
            setManuallyHidden(true);
          }
        }}
        onPointerCancel={(event) => {
          if (gesture.current?.id === event.pointerId) cancelGesture();
        }}
        onLostPointerCapture={(event) => {
          if (gesture.current?.id === event.pointerId) cancelGesture();
        }}
        onBlur={cancelGesture}
        onClick={(event) => {
          if (event.detail === 0) void toggle();
        }}
      />
      <div className="motion-feedback">
        {(!playback.switching && !playback.discovering && failed) ||
        playback.error ||
        playError ||
        displayError ? (
          <div className="motion-error">
            <ErrorNotice
              error={{
                messageKey:
                  playback.error === 'failed'
                    ? 'viewer.videoTrackFailed'
                    : failed || playback.error === 'unsupported'
                      ? 'viewer.mediaUnsupported'
                      : playError
                        ? 'viewer.audioPlayFailed'
                        : 'viewer.videoDisplayFailed',
              }}
            />
            {(failed || playback.error) && (
              <button type="button" className="text-button" onClick={retry}>
                {t('viewer.audioRetry')}
              </button>
            )}
          </div>
        ) : (
          <span role="status">
            {playback.switching
              ? t('viewer.videoTrackSwitching')
              : !state.ready
                ? t('viewer.videoLoading')
                : showWaiting
                  ? t('viewer.videoBuffering')
                  : ''}
          </span>
        )}
      </div>
      <div className="motion-controls" ref={controls}>
        <VideoTimeline
          media={media}
          src={src}
          size={source.size}
          duration={duration}
          seekable={seekable}
        />
        <div className="motion-toolbar">
          <VideoButton
            label={t(state.paused ? 'viewer.audioPlay' : 'viewer.audioPause')}
            icon={state.paused ? 'play' : 'pause'}
            disabled={playback.switching || (state.paused && (!state.ready || failed))}
            onClick={() => void toggle()}
            className="motion-play"
          />
          <VideoButton
            label={t('viewer.audioBack')}
            icon="back"
            disabled={!seekable}
            onClick={() => skip(-10)}
          />
          <VideoButton
            label={t('viewer.audioForward')}
            icon="forward"
            disabled={!seekable}
            onClick={() => skip(10)}
          />
          <div className="motion-volume">
            <VideoButton
              label={t(silent ? 'viewer.audioUnmute' : 'viewer.audioMute')}
              icon={silent ? 'mute' : 'volume'}
              onClick={mute}
              disabled={playback.switching}
            />
            <input
              disabled={playback.switching}
              className="motion-range motion-volume-input"
              type="range"
              min={0}
              max={100}
              step={1}
              aria-label={t('viewer.audioVolume')}
              aria-valuetext={`${format.number(silent ? 0 : state.volume * 100, 0)}%`}
              value={silent ? 0 : state.volume * 100}
              style={
                { '--motion-progress': `${silent ? 0 : state.volume * 100}%` } as CSSProperties
              }
              onChange={(event) => {
                if (!media.current) return;
                const volume = Number(event.target.value) / 100;
                media.current.volume = volume;
                media.current.muted = volume === 0;
                if (volume > 0) lastVolume.current = volume;
                sync();
              }}
            />
          </div>
          <div className="motion-options">
            {playback.tracks.length > 1 && (
              <ViewerSelect
                label={t('viewer.videoAudioTrack')}
                value={playback.selectedId ?? ''}
                className="motion-audio-track"
                triggerContent={<VideoIcon kind="tracks" />}
                options={playback.tracks.map((track, index) => {
                  let language = '';
                  if (track.language && track.language !== 'und') {
                    try {
                      language =
                        new Intl.DisplayNames([locale === 'it' ? 'it' : 'en'], {
                          type: 'language',
                        }).of(track.language) ?? track.language;
                    } catch {
                      language = track.language;
                    }
                  }
                  const name =
                    track.name || language || t('viewer.videoTrackNumber', { number: index + 1 });
                  return {
                    value: track.id,
                    label: track.supported ? name : t('viewer.videoTrackUnavailable', { name }),
                    disabled: !track.supported,
                  };
                })}
                onChange={(id) => {
                  cancelBoosts();
                  playback.select(id);
                }}
              />
            )}
            <VideoButton
              label={t('viewer.audioRepeat')}
              icon="repeat"
              pressed={repeat}
              onClick={() => {
                if (media.current) media.current.loop = !repeat;
                setRepeat(!repeat);
              }}
            />
            <ViewerSelect
              label={t('viewer.audioSpeed')}
              value={String(state.rate)}
              className="motion-speed"
              disabled={playback.switching}
              options={speeds.map((speed) => ({
                value: String(speed),
                label: `${format.number(speed, 2)}×`,
              }))}
              onChange={(value) => {
                if (boost.current.owners.size) boost.current.rate = Number(value);
                else if (media.current) media.current.playbackRate = Number(value);
                sync();
              }}
            />
            {document.pictureInPictureEnabled && (
              <VideoButton
                label={t(pip ? 'viewer.videoExitPip' : 'viewer.videoPip')}
                icon="pip"
                pressed={pip}
                disabled={!state.ready || failed || displayPending}
                onClick={() => void changeDisplay('pip')}
              />
            )}
            {document.fullscreenEnabled && (
              <VideoButton
                label={t(fullscreen ? 'viewer.videoExitFullscreen' : 'viewer.videoFullscreen')}
                icon={fullscreen ? 'exitFullscreen' : 'fullscreen'}
                disabled={displayPending}
                onClick={() => void changeDisplay('fullscreen')}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function VideoButton({
  label,
  icon,
  onClick,
  disabled,
  pressed,
  className = '',
}: {
  label: string;
  icon: VideoIconKind;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={`motion-button ${className}`}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        <VideoIcon kind={icon} />
      </button>
    </Tooltip>
  );
}

/** Display-frame interpolation is confined here; native video rendering remains authoritative. */
function VideoTimeline({
  media,
  src,
  size,
  duration,
  seekable,
}: {
  media: RefObject<HTMLVideoElement | null>;
  src: string;
  size: number;
  duration: number;
  seekable: boolean;
}) {
  const t = useT();
  const [time, setTime] = useState(0);
  const [buffered, setBuffered] = useState<{ start: number; end: number }[]>([]);
  const [draft, setDraft] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const scrubbing = useRef(false);
  const previewTime = draft ?? hover;
  const thumbnail = useVideoThumbnail({ url: src, size, time: seekable ? previewTime : null });
  useLayoutEffect(() => {
    const video = media.current;
    if (!video) return;
    let raf = 0;
    let waiting = false;
    const clock = new AudioPlaybackClock();
    const sync = () => setTime(clock.reset(video.currentTime, performance.now()));
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const canAnimate = () =>
      !waiting &&
      !video.paused &&
      !video.ended &&
      !video.error &&
      !document.hidden &&
      !video.seeking &&
      video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    const queue = () => {
      if (!canAnimate()) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!canAnimate()) {
          sync();
          return;
        }
        setTime(clock.sample(video.currentTime, performance.now(), video.playbackRate));
        queue();
      });
    };
    const start = () => {
      stop();
      sync();
      queue();
    };
    const hold = () => {
      stop();
      sync();
    };
    const buffering = () => {
      waiting = true;
      hold();
    };
    const playing = () => {
      waiting = false;
      start();
    };
    const observe = () => {
      if (!raf) sync();
    };
    const progress = () => {
      const ranges = [];
      for (let index = 0; index < video.buffered.length; index++)
        ranges.push({ start: video.buffered.start(index), end: video.buffered.end(index) });
      setBuffered(ranges);
    };
    const visibility = () => {
      if (document.hidden) hold();
      else start();
    };
    const holds = ['pause', 'seeking', 'ended', 'emptied', 'error'];
    for (const event of holds) video.addEventListener(event, hold);
    video.addEventListener('waiting', buffering);
    video.addEventListener('playing', playing);
    video.addEventListener('seeked', start);
    for (const event of ['loadedmetadata', 'timeupdate']) video.addEventListener(event, observe);
    video.addEventListener('ratechange', sync);
    for (const event of ['progress', 'loadedmetadata', 'emptied'])
      video.addEventListener(event, progress);
    document.addEventListener('visibilitychange', visibility);
    start();
    progress();
    return () => {
      stop();
      for (const event of holds) video.removeEventListener(event, hold);
      video.removeEventListener('waiting', buffering);
      video.removeEventListener('playing', playing);
      video.removeEventListener('seeked', start);
      for (const event of ['loadedmetadata', 'timeupdate'])
        video.removeEventListener(event, observe);
      video.removeEventListener('ratechange', sync);
      for (const event of ['progress', 'loadedmetadata', 'emptied'])
        video.removeEventListener(event, progress);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [media]);
  function seek(value: number) {
    if (!media.current || !seekable) return;
    const next = Math.max(0, Math.min(duration, value));
    media.current.currentTime = next;
    setTime(next);
  }
  function finish(value: number) {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    seek(value);
    setDraft(null);
  }
  function cancel() {
    scrubbing.current = false;
    setDraft(null);
  }
  const displayedTime = draft ?? Math.max(0, Math.min(duration || Infinity, time));
  return (
    <div className="motion-timeline">
      <div className="motion-seek">
        <div className="motion-buffered" aria-hidden="true">
          {duration > 0 &&
            buffered.map((range) => (
              <span
                key={range.start}
                style={{
                  left: `${(range.start / duration) * 100}%`,
                  width: `${((range.end - range.start) / duration) * 100}%`,
                }}
              />
            ))}
        </div>
        <input
          className="motion-range motion-seek-input"
          data-media-seek
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
              '--motion-progress': `${duration ? (displayedTime / duration) * 100 : 0}%`,
            } as CSSProperties
          }
          onPointerMove={(event) => {
            if (!seekable) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            setHover(
              Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * duration,
            );
          }}
          onPointerLeave={() => setHover(null)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            scrubbing.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (scrubbing.current) setDraft(value);
            else seek(value);
          }}
          onPointerUp={(event) => {
            finish(Number(event.currentTarget.value));
            if (event.pointerType === 'touch') setHover(null);
          }}
          onBlur={(event) => {
            finish(Number(event.currentTarget.value));
            setHover(null);
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
        />
        {previewTime !== null && seekable && (
          <div
            className="motion-preview"
            aria-hidden="true"
            style={
              {
                '--motion-preview-position': `${duration ? (previewTime / duration) * 100 : 0}%`,
              } as CSSProperties
            }
          >
            {thumbnail && <img src={thumbnail.src} alt="" />}
            <span>{clock(thumbnail?.time ?? previewTime)}</span>
          </div>
        )}
      </div>
      <div className="motion-times" aria-hidden="true">
        <span>{clock(displayedTime)}</span>
        <span>{duration ? clock(duration) : '—'}</span>
      </div>
    </div>
  );
}

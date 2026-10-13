import { type RefObject, useLayoutEffect } from 'react';

/** Fit the source ratio into the remaining page viewport without cropping or scroll feedback. */
export function useVideoLayout(
  stage: RefObject<HTMLDivElement | null>,
  media: RefObject<HTMLVideoElement | null>,
  controls: RefObject<HTMLDivElement | null>,
) {
  useLayoutEffect(() => {
    const root = stage.current;
    const video = media.current;
    const toolbar = controls.current;
    if (!root || !video || !toolbar) return;
    let ratio = 16 / 9;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (document.fullscreenElement === root) return;
      // Source switches briefly clear metadata: retain the known geometry until it returns.
      if (video.videoWidth > 0 && video.videoHeight > 0)
        ratio = video.videoWidth / video.videoHeight;
      const bounds = root.getBoundingClientRect();
      const documentTop = bounds.top + window.scrollY;
      const viewport = window.visualViewport?.height ?? document.documentElement.clientHeight;
      const available = viewport - documentTop - 16;
      // Very short windows may scroll rather than crush the timeline and touch targets.
      const minimum = Math.max(160, toolbar.offsetHeight + 24);
      const height = Math.round(Math.max(minimum, Math.min(bounds.width / ratio, available)));
      const value = `${height}px`;
      if (root.style.getPropertyValue('--motion-height') !== value)
        root.style.setProperty('--motion-height', value);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    observer.observe(toolbar);
    const main = root.closest('main');
    if (main) observer.observe(main);
    video.addEventListener('loadedmetadata', schedule);
    video.addEventListener('resize', schedule);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    document.addEventListener('fullscreenchange', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      video.removeEventListener('loadedmetadata', schedule);
      video.removeEventListener('resize', schedule);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      document.removeEventListener('fullscreenchange', schedule);
    };
  }, [stage, media, controls]);
}

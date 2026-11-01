import { type RefObject, useLayoutEffect, useRef } from 'react';

/** Presentation only: decoded peaks and the playback timeline remain immediate. */
export function useWaveformReveal(
  root: RefObject<HTMLDivElement | null>,
  source: string,
  bars: readonly number[],
) {
  const state = useRef({
    seen: new Set<number>(),
    animations: new Map<Element, Animation>(),
    nextStart: 0,
    count: 0,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset the animation lifecycle when the selected file changes.
  useLayoutEffect(() => {
    const current = state.current;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const cancel = () => {
      for (const animation of current.animations.values()) animation.cancel();
      current.animations.clear();
      current.nextStart = 0;
    };
    current.seen.clear();
    current.count = 0;
    motion.addEventListener('change', cancel);
    return () => {
      motion.removeEventListener('change', cancel);
      cancel();
    };
  }, [source]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const current = state.current;
    const nodes = element.querySelectorAll<SVGRectElement>('.wave-envelope-unplayed rect');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const resized = current.count !== 0 && current.count !== nodes.length;
    if (resized) {
      for (const animation of current.animations.values()) animation.cancel();
      current.animations.clear();
      current.seen.clear();
      current.nextStart = 0;
    }
    current.count = nodes.length;
    const now = performance.now();
    for (let index = 0; index < nodes.length; index++) {
      const bar = nodes[index];
      const height = Math.max(2, Math.sqrt(bars[index] ?? 0) * 110);
      if (!bar || height <= 2) continue;
      const frames = [
        { transform: 'scaleY(0.01818181818181818)' },
        { transform: `scaleY(${height / 110})` },
      ];
      const pair = element.querySelectorAll<SVGRectElement>(`[data-wave-bar="${index}"]`);
      if (current.seen.has(index)) {
        // Further samples can refine a bar while it is still revealing.
        for (const node of pair) {
          const animation = current.animations.get(node);
          if (animation?.playState === 'running')
            (animation.effect as KeyframeEffect).setKeyframes(frames);
        }
        continue;
      }
      current.seen.add(index);
      if (reduced || resized) continue;
      const start = Math.max(now, current.nextStart);
      current.nextStart = start + 8;
      for (const node of pair) {
        const animation = node.animate(frames, {
          duration: 180,
          delay: start - now,
          easing: 'ease-out',
          fill: 'backwards',
        });
        current.animations.set(node, animation);
        animation.onfinish = () => {
          if (current.animations.get(node) === animation) current.animations.delete(node);
        };
      }
    }
  }, [bars, root]);
}

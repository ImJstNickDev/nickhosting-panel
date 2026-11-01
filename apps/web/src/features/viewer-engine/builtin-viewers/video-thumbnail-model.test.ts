import { describe, expect, it, vi } from 'vitest';
import {
  ThumbnailReadBudget,
  ThumbnailSession,
  thumbnailBucket,
  thumbnailLimits,
} from './video-thumbnail-model.js';

function fixture() {
  let count = 0;
  const create = vi.fn(() => `blob:thumbnail-${++count}`);
  const revoke = vi.fn();
  const session = new ThumbnailSession(create, revoke);
  const finish = (bucket: number, key = bucket, time = key + 0.001) => {
    session.complete({ type: 'thumbnail', bucket, key, time, blob: new Blob(['frame']) });
  };
  return { session, create, revoke, finish };
}

describe('Motion thumbnail session', () => {
  it('bounds all streamed response bytes per preview, including metadata and prefetch', () => {
    const budget = new ThumbnailReadBudget();
    budget.consume(thumbnailLimits.readBytes - 4);
    budget.consume(4);
    expect(() => budget.consume(1)).toThrow('Thumbnail read budget exceeded');
    budget.reset();
    expect(() => budget.consume(thumbnailLimits.readBytes)).not.toThrow();
  });
  it('coalesces nearby positions and ignores unsupported pointer times', () => {
    expect([null, -1, NaN, Infinity].map(thumbnailBucket)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect([0, 0.9, 1.99, 2, 3.8].map(thumbnailBucket)).toEqual([0, 0, 0, 2, 2]);
  });

  it('permits one decode at a time and keeps only the latest pending hover', () => {
    const { session, finish } = fixture();
    session.want(2.1);
    expect(session.next()?.bucket).toBe(2);
    session.want(6);
    session.want(14);
    expect(session.next()).toBeUndefined();
    finish(2);
    expect(session.read()).toBeUndefined();
    expect(session.next()?.bucket).toBe(14);
    finish(14, 12, 12.034);
    expect(session.read()).toEqual({ src: 'blob:thumbnail-2', time: 12.034 });
    expect(session.next()).toBeUndefined();
  });

  it('shares an actual keyframe across buckets without another retained blob or URL', () => {
    const { session, create, finish } = fixture();
    session.want(2);
    session.next();
    finish(2, 0, 0.033);
    session.want(4);
    expect(session.next()).toEqual({ bucket: 4, cachedKeys: [0] });
    session.complete({ type: 'thumbnail', bucket: 4, key: 0, time: 0 });
    expect(session.read()?.time).toBe(0.033);
    expect(create).toHaveBeenCalledOnce();
    session.want(2);
    expect(session.next()).toBeUndefined();
    expect(session.read()?.src).toBe('blob:thumbnail-1');
  });

  it('evicts URLs and their aliases so seeking backward requests the frame again', () => {
    const { session, revoke, finish } = fixture();
    for (let i = 0; i < 33; i++) {
      session.want(i * 2);
      session.next();
      finish(i * 2);
    }
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:thumbnail-1');
    session.want(0);
    const request = session.next();
    expect(request?.bucket).toBe(0);
    expect(request?.cachedKeys).toHaveLength(32);
    expect(request?.cachedKeys).not.toContain(0);
    finish(0);
    expect(session.read()?.src).toBe('blob:thumbnail-34');
    session.dispose();
    expect(revoke).toHaveBeenCalledTimes(34);
    expect(new Set(revoke.mock.calls.map(([src]) => src)).size).toBe(34);
  });

  it('drops pending work on hover exit and releases every URL once on disposal', () => {
    const { session, create, revoke, finish } = fixture();
    session.want(0);
    session.next();
    session.want(8);
    session.want(null);
    finish(0);
    expect(session.next()).toBeUndefined();
    expect(session.read()).toBeUndefined();
    session.dispose();
    session.dispose();
    finish(8);
    session.want(10);
    expect(session.next()).toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:thumbnail-1');
  });

  it('cancels in-flight work without discarding cached previews', () => {
    const { session, finish, create, revoke } = fixture();
    session.want(0);
    session.next();
    finish(0);
    session.want(4);
    session.next();
    session.cancelPending();
    finish(4);
    expect(create).toHaveBeenCalledOnce();
    expect(session.next()).toBeUndefined();
    session.want(0);
    expect(session.read()?.src).toBe('blob:thumbnail-1');
    expect(session.next()).toBeUndefined();
    session.want(4);
    expect(session.next()?.bucket).toBe(4);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('remembers empty buckets and bounds aliases even across one long GOP', () => {
    const { session, create, finish } = fixture();
    session.want(0);
    session.next();
    session.complete({ type: 'empty', bucket: 0 });
    expect(session.next()).toBeUndefined();
    for (let i = 1; i <= 130; i++) {
      session.want(i * 2);
      session.next();
      finish(i * 2, 1);
    }
    expect(create).toHaveBeenCalledOnce();
    session.want(0);
    expect(session.next()?.bucket).toBe(0);
  });
});

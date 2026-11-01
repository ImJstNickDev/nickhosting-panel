import { describe, expect, it } from 'vitest';
import { observationHealth } from './health.js';

describe('diagnostic observation freshness', () => {
  const now = new Date('2030-01-01T12:00:00Z');
  it('keeps missing, stale and invalid/future timestamps distinct from healthy', () => {
    expect(observationHealth(null, now, 30_000).status).toBe('unknown');
    expect(observationHealth(new Date('2030-01-01T11:59:00Z'), now, 30_000).status).toBe('stale');
    expect(observationHealth(new Date('2030-01-01T12:00:01Z'), now, 30_000).status).toBe('unknown');
    expect(observationHealth(new Date('invalid'), now, 30_000).status).toBe('unknown');
    expect(observationHealth(new Date('2030-01-01T11:59:50Z'), now, 30_000).status).toBe('healthy');
  });
});

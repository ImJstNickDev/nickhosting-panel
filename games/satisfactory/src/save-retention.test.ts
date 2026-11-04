import { describe, expect, it } from 'vitest';
import {
  safetySaveRotationCandidates,
  satisfactorySafetySaveName,
  satisfactorySafetySaveRetentionSchema,
} from './save-retention.js';

describe('Satisfactory safety-save policy', () => {
  it('rotates separately per session and always protects its newest recovery point', () => {
    const receipts = [
      { session_name: 'A', name: 'A3' },
      { session_name: 'B', name: 'B2' },
      { session_name: 'A', name: 'A2' },
      { session_name: 'B', name: 'B1' },
      { session_name: 'A', name: 'A1' },
    ];
    expect(
      safetySaveRotationCandidates(receipts, (session) => (session === 'A' ? 2 : 0)).map(
        (receipt) => receipt.name,
      ),
    ).toEqual(['B1', 'A1']);
  });
  it('accepts only exact generated names, never prefix lookalikes or paths', () => {
    expect(satisfactorySafetySaveName.test('nh-stop-07397400-f5cd-4ac9-860d-0c577ae4fdf9')).toBe(
      true,
    );
    for (const name of [
      'nh-stop-manual',
      '../nh-stop-07397400-f5cd-4ac9-860d-0c577ae4fdf9',
      'nh-stop-07397400-f5cd-4ac9-860d-0c577ae4fdf9.sav',
    ])
      expect(satisfactorySafetySaveName.test(name)).toBe(false);
  });
  it('rejects destructive or unbounded retention policies', () => {
    for (const keep of [0, -1, 101, 1.5, '5'])
      expect(
        satisfactorySafetySaveRetentionSchema.safeParse({ sessionName: 'Test', keep }).success,
      ).toBe(false);
  });
});

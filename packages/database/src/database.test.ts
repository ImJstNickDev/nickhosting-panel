import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from './index.js';

describe('database pool failures', () => {
  it('handles idle connection errors without logging raw credentials or terminating', async () => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const database = createDatabase('postgresql://fixture:fixture@localhost/fixture');
    try {
      database.pool.emit('error', new Error('fixture-private-database-detail'));
      expect(output).toHaveBeenCalledWith('{"level":"error","event":"database.connection_lost"}\n');
      expect(JSON.stringify(output.mock.calls)).not.toContain('fixture-private-database-detail');
    } finally {
      await database.db.destroy();
      output.mockRestore();
    }
  });
});

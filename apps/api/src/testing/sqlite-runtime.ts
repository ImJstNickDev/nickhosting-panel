/** Subprocess regression entry: exercises the actual session factory and Worker URL. */
import { stat } from 'node:fs/promises';
import { cachedFileSource, ViewerCache } from '../viewer-cache.js';
import { openSqliteViewer } from '../viewer-sqlite.js';

const [path, root] = process.argv.slice(2);
if (!path || !root) throw new Error('fixture arguments required');
const metadata = await stat(path);
const cache = new ViewerCache({ root });
const viewer = await openSqliteViewer(
  {
    ...cachedFileSource(path, metadata.size, metadata.mtimeMs),
    restat: () => stat(path),
    siblingExists: async () => false,
  },
  { cache, key: 'runtime-regression' },
);
try {
  const page = await viewer.rows({ table: 'players', sort: 'id', direction: 'desc' });
  const detail = await viewer.cell({
    table: 'players',
    sort: 'id',
    direction: 'desc',
    rowOffset: 0,
    column: 'name',
    revision: viewer.revision,
  });
  process.stdout.write(JSON.stringify({ page, detail }));
} finally {
  await viewer.close();
  await cache.close();
}

import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Private derived data. SQLite keeps concurrent API processes and partial writes atomic.
// Bound both payload and row count, with an independent physical limit on the database.
const MAX_PAYLOAD = 192 * 1024 ** 2;
const MAX_ENTRIES = 32768;
const MAX_VALUE = 24 * 1024 ** 2;

export class MinecraftTextureStore {
  #database?: Promise<DatabaseSync>;
  constructor(readonly root: string) {}

  #open(): Promise<DatabaseSync> {
    this.#database ??= this.#initialize().catch((error) => {
      this.#database = undefined;
      throw error;
    });
    return this.#database;
  }

  async #initialize() {
    const root = resolve(this.root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await realpath(root)) !== root) throw new Error('minecraft_texture_cache_directory');
    const directory = join(root, 'minecraft-inventory');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      (await realpath(directory)) !== directory ||
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('minecraft_texture_cache_directory');
    const path = join(directory, 'cache-v1.sqlite');
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const entry = await handle.stat();
      if (!entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o077) !== 0)
        throw new Error('minecraft_texture_cache_file');
    } finally {
      await handle.close();
    }
    const db = new DatabaseSync(path, { timeout: 250 });
    try {
      const appId = db.prepare('PRAGMA application_id').get()?.application_id;
      if (
        appId !== 0x4e485458 &&
        (appId !== 0 || db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get())
      )
        throw new Error('minecraft_texture_cache_format');
      db.exec(`
        PRAGMA application_id=0x4e485458;
        PRAGMA page_size=4096;
        PRAGMA max_page_count=65536;
        CREATE TABLE IF NOT EXISTS entries (key TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, bytes INTEGER NOT NULL, count INTEGER NOT NULL);
        INSERT OR IGNORE INTO usage VALUES (1,0,0);
        CREATE TRIGGER IF NOT EXISTS insert_entry AFTER INSERT ON entries BEGIN
          UPDATE usage SET bytes=bytes+length(NEW.value), count=count+1 WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS update_entry AFTER UPDATE ON entries BEGIN
          UPDATE usage SET bytes=bytes-length(OLD.value)+length(NEW.value) WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS delete_entry AFTER DELETE ON entries BEGIN
          UPDATE usage SET bytes=bytes-length(OLD.value), count=count-1 WHERE id=1;
        END;
      `);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  async read(key: string): Promise<string | undefined> {
    const db = await this.#open();
    const row = db
      .prepare('SELECT value FROM entries WHERE key=? AND length(value)<=?')
      .get(key, MAX_VALUE);
    return typeof row?.value === 'string' ? row.value : undefined;
  }

  async write(entries: readonly [string, string][], replace = false) {
    if (!entries.length) return;
    const db = await this.#open();
    db.exec('BEGIN IMMEDIATE');
    try {
      const usage = db.prepare('SELECT bytes, count FROM usage WHERE id=1');
      const discard = db.prepare(
        'DELETE FROM entries WHERE rowid IN (SELECT rowid FROM entries ORDER BY rowid LIMIT 256)',
      );
      const insert = db.prepare(
        replace
          ? 'INSERT INTO entries(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
          : 'INSERT OR IGNORE INTO entries(key,value) VALUES (?,?)',
      );
      for (const [key, value] of entries) {
        if (value.length > MAX_VALUE) continue;
        for (;;) {
          const row = usage.get();
          if (Number(row?.bytes) + value.length <= MAX_PAYLOAD && Number(row?.count) < MAX_ENTRIES)
            break;
          if (!discard.run().changes) break;
        }
        insert.run(key, value);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async close() {
    const database = this.#database;
    this.#database = undefined;
    (await database)?.close();
  }
}

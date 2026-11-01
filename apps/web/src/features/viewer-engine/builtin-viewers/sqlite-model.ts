import type { DatagridPage } from '@nickhosting/game-sdk/ui';

/** Instance-local only: disposed with the identity/server/source keyed viewer. */
export class DatagridPageCache {
  private pages = new Map<string, { page: DatagridPage; bytes: number }>();
  private bytes = 0;
  revision: string | undefined;
  get(key: string) {
    const entry = this.pages.get(key);
    if (!entry) return undefined;
    this.pages.delete(key);
    this.pages.set(key, entry);
    return entry.page;
  }
  put(key: string, page: DatagridPage) {
    if (this.revision && this.revision !== page.revision) return false;
    this.revision = page.revision;
    const bytes = JSON.stringify(page).length * 2;
    const previous = this.pages.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.pages.delete(key);
    if (bytes > 4 * 1024 * 1024) return true;
    this.pages.set(key, { page, bytes });
    this.bytes += bytes;
    while (this.pages.size > 8 || this.bytes > 4 * 1024 * 1024) {
      const oldest = this.pages.entries().next().value;
      if (!oldest) break;
      this.pages.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
    return true;
  }
  clear() {
    this.pages.clear();
    this.bytes = 0;
    this.revision = undefined;
  }
}

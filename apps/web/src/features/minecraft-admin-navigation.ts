type NavigationKind = 'POP' | 'PUSH' | 'REPLACE';

/** Merge field changes against the latest requested catalog URL. React Router
 * can commit an earlier replacement between two input events. Such a commit
 * acknowledges navigation, but must not discard later field changes. */
export class PendingCatalogSearch {
  private key: string;
  private search: string;
  private issued: string[] = [];

  constructor(key: string, search: string) {
    this.key = key;
    this.search = search;
  }

  reconcile(key: string, search: string, kind: NavigationKind) {
    if (key === this.key) return;
    this.key = key;
    const index = kind === 'REPLACE' ? this.issued.indexOf(search) : -1;
    if (index < 0) {
      // Browser history and navigation outside this workspace remain authoritative.
      this.search = search;
      this.issued = [];
      return;
    }
    this.issued = this.issued.slice(index + 1);
    this.search = this.issued.at(-1) ?? search;
  }

  current() {
    return new URLSearchParams(this.search);
  }

  patch(values: Record<string, string>, resetPage: boolean) {
    const next = this.current();
    if (resetPage) {
      next.set('catalogPage', '1');
      next.delete('combination');
    }
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    this.search = next.toString();
    // Only transient in-flight URLs, never a navigation history or persistent cache.
    this.issued.push(this.search);
    if (this.issued.length > 128) this.issued.splice(0, this.issued.length - 128);
    return next;
  }
}

/**
 * Client-side cache stores.
 *
 * Two tiers, deliberately synchronous-first:
 *
 *   Memory  a bounded LRU of decoded values. A hit is a property read — no
 *           await, no structured clone, no I/O. This is the tier that makes a
 *           re-render free.
 *   IDB     IndexedDB, for surviving a reload. A second visit to a page can be
 *           served entirely from disk, which is where most real invocation
 *           traffic hides.
 *
 * Both are best-effort: IndexedDB is absent in some runtimes, full, or blocked
 * in private-mode browsers, and none of that may ever surface to the caller.
 */

export interface CacheEntry {
  readonly data: unknown;
  /** Server ETag, for conditional revalidation that costs 0 handler runs. */
  readonly etag: string | undefined;
  readonly storedAt: number;
  /** Fresh until this timestamp: serve instantly, never revalidate. */
  readonly freshUntil: number;
  /** Usable until this timestamp: serve instantly, revalidate in background. */
  readonly staleUntil: number;
}

export type Lookup =
  | { readonly state: "miss" }
  | { readonly state: "fresh"; readonly entry: CacheEntry }
  | { readonly state: "stale"; readonly entry: CacheEntry };

/* -------------------------------------------------------------------------- */
/*                                   Memory                                    */
/* -------------------------------------------------------------------------- */

export class MemoryStore {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #max: number;

  constructor(maxEntries = 200) {
    this.#max = Math.max(16, maxEntries | 0);
  }

  get size(): number {
    return this.#entries.size;
  }

  lookup(key: string): Lookup {
    const entry = this.#entries.get(key);
    if (entry === undefined) return { state: "miss" };
    const now = Date.now();
    if (now <= entry.freshUntil) {
      this.#touch(key, entry);
      return { state: "fresh", entry };
    }
    if (now <= entry.staleUntil) {
      this.#touch(key, entry);
      return { state: "stale", entry };
    }
    this.#entries.delete(key);
    return { state: "miss" };
  }

  set(key: string, entry: CacheEntry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  deletePrefix(prefix: string): number {
    let dropped = 0;
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.#entries.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }

  clear(): number {
    const size = this.#entries.size;
    this.#entries.clear();
    return size;
  }

  #touch(key: string, entry: CacheEntry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }
}

/* -------------------------------------------------------------------------- */
/*                                IndexedDB                                    */
/* -------------------------------------------------------------------------- */

interface IdbRow {
  key: string;
  data: unknown;
  etag: string | undefined;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
}

const DB_NAME = "navi-cache";
const DB_VERSION = 1;
const STORE = "entries";

function idbFactory(): IDBFactory | undefined {
  const candidate = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  return candidate !== undefined && typeof candidate.open === "function" ? candidate : undefined;
}

/**
 * Persistent client cache.
 *
 * Every operation is wrapped so a hostile environment (no IndexedDB, blocked
 * storage, a schema from an older Navi) degrades to a permanent miss instead of
 * an exception. Nothing here is ever awaited on the response path *before* the
 * memory tier has been consulted.
 */
export class IdbStore {
  readonly #factory: IDBFactory | undefined;
  readonly #max: number;
  #db: IDBDatabase | undefined;
  #writes = 0;
  #opening: Promise<IDBDatabase | undefined> | undefined;
  #disabled = false;

  constructor(maxEntries = 500) {
    this.#factory = idbFactory();
    this.#max = Math.max(32, maxEntries | 0);
    if (this.#factory === undefined) this.#disabled = true;
  }

  get enabled(): boolean {
    return !this.#disabled;
  }

  async lookup(key: string): Promise<Lookup> {
    const row = await this.#read(key);
    if (row === undefined) return { state: "miss" };
    const now = Date.now();
    if (now <= row.freshUntil) return { state: "fresh", entry: row };
    if (now <= row.staleUntil) return { state: "stale", entry: row };
    await this.delete(key);
    return { state: "miss" };
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const db = await this.#connect();
    if (db === undefined) return;
    const row: IdbRow = {
      key,
      data: entry.data,
      etag: entry.etag,
      storedAt: entry.storedAt,
      freshUntil: entry.freshUntil,
      staleUntil: entry.staleUntil,
    };
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(row);
      await settled(tx);
      // Opportunistic trim, on a small fraction of writes, so a long-lived tab
      // cannot grow without bound.
      if (this.#writes++ % 20 === 0) await this.#trim();
    } catch {
      this.#disable();
    }
  }

  async delete(key: string): Promise<void> {
    const db = await this.#connect();
    if (db === undefined) return;
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      await settled(tx);
    } catch {
      this.#disable();
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.keys();
    const doomed = keys.filter((key) => key.startsWith(prefix));
    for (const key of doomed) await this.delete(key);
    return doomed.length;
  }

  async keys(): Promise<string[]> {
    const db = await this.#connect();
    if (db === undefined) return [];
    try {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).openCursor();
      const out: string[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) return;
        out.push(String((cursor.value as IdbRow).key));
        cursor.continue();
      };
      await request;
      return out;
    } catch {
      return [];
    }
  }

  async clear(): Promise<number> {
    const db = await this.#connect();
    if (db === undefined) return 0;
    const size = (await this.keys()).length;
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      await settled(tx);
      return size;
    } catch {
      this.#disable();
      return 0;
    }
  }

  /** Newest-last eviction: the store is append-ordered by write time. */
  async #trim(): Promise<void> {
    const db = await this.#connect();
    if (db === undefined) return;
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const request = store.openCursor();
      let position = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null) return;
        position++;
        if (position > this.#max) cursor.delete();
        cursor.continue();
      };
      await request;
    } catch {
      this.#disable();
    }
  }

  async #read(key: string): Promise<CacheEntry | undefined> {
    const db = await this.#connect();
    if (db === undefined) return undefined;
    try {
      const tx = db.transaction(STORE, "readonly");
      const row = await promiseOf(tx.objectStore(STORE).get(key));
      if (row === undefined || row === null) return undefined;
      return {
        data: row.data,
        etag: row.etag ?? undefined,
        storedAt: row.storedAt,
        freshUntil: row.freshUntil,
        staleUntil: row.staleUntil,
      };
    } catch {
      return undefined;
    }
  }

  #disable(): void {
    this.#disabled = true;
    this.#db = undefined;
  }

  #connect(): Promise<IDBDatabase | undefined> {
    if (this.#disabled) return Promise.resolve(undefined);
    if (this.#db !== undefined) return Promise.resolve(this.#db);
    this.#opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
      const factory = this.#factory;
      if (factory === undefined) {
        resolve(undefined);
        return;
      }
      let settled = false;
      const finish = (value: IDBDatabase | undefined): void => {
        if (settled) return;
        settled = true;
        if (value === undefined) this.#disabled = true;
        resolve(value);
      };
      try {
        const request = factory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
        };
        request.onsuccess = () => {
          const db = request.result;
          // A version change from another tab invalidates this handle.
          db.onversionchange = () => db.close();
          finish(db);
        };
        request.onerror = () => finish(undefined);
        request.onblocked = () => finish(undefined);
      } catch {
        finish(undefined);
      }
    });
    this.#opening = this.#opening.then((db) => {
      this.#db = db;
      return db;
    });
    return this.#opening;
  }

}

/** Resolves when an `IDBRequest` settles; rejects on error. */
function promiseOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolves when a transaction commits. */
function settled(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

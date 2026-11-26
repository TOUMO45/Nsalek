// Transactional store contract shared by the in-memory store (tests, temporary restore
// validation) and the IndexedDB store (browser). A command runs entirely inside one
// read-write transaction; nothing outside the store may be awaited inside it.
import { DomainError, type RowMap, type StoreName } from "./types.ts";

export const INDEXES: Partial<Record<StoreName, string[]>> = {
  parties: ["workspaceId"],
  obligations: ["workspaceId", "partyId"],
  adjustments: ["workspaceId", "obligationId", "partyId"],
  payments: ["workspaceId", "partyId"],
  allocations: ["workspaceId", "paymentId", "obligationId", "partyId"],
  installmentPlans: ["workspaceId", "obligationId"],
  recurringPlans: ["workspaceId"],
  promises: ["workspaceId", "partyId"],
  reminders: ["workspaceId", "partyId"],
  invoices: ["workspaceId"],
  notes: ["workspaceId"],
  attachments: ["workspaceId", "ownerId"],
  audit: ["workspaceId"],
  importBatches: ["workspaceId"],
  cashEntries: ["workspaceId"],
};

export interface Tx {
  get<K extends StoreName>(store: K, id: string): Promise<RowMap[K] | undefined>;
  all<K extends StoreName>(store: K): Promise<RowMap[K][]>;
  where<K extends StoreName>(store: K, field: string, value: string): Promise<RowMap[K][]>;
  put<K extends StoreName>(store: K, value: RowMap[K]): Promise<void>;
  /** Inserts; throws DomainError("exists") if the id is taken. */
  add<K extends StoreName>(store: K, value: RowMap[K]): Promise<void>;
  delete(store: StoreName, id: string): Promise<void>;
  clear(store: StoreName): Promise<void>;
}

export interface Store {
  run<T>(mode: "readonly" | "readwrite", fn: (tx: Tx) => Promise<T>): Promise<T>;
  close?(): void;
}

const assertIndexed = (store: StoreName, field: string) => {
  if (!INDEXES[store]?.includes(field)) throw new Error(`no index ${store}.${field}`);
};

/** Serializable, rollback-on-error in-memory store. */
export class MemoryStore implements Store {
  private stores = new Map<StoreName, Map<string, unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Test hook: make the next read-write commit fail (simulates quota or I/O failure). */
  failNextCommit: Error | null = null;

  private table(name: StoreName) {
    let t = this.stores.get(name);
    if (!t) {
      t = new Map();
      this.stores.set(name, t);
    }
    return t;
  }

  run<T>(mode: "readonly" | "readwrite", fn: (tx: Tx) => Promise<T>): Promise<T> {
    const job = this.queue.then(() => this.exec(mode, fn));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async exec<T>(mode: "readonly" | "readwrite", fn: (tx: Tx) => Promise<T>): Promise<T> {
    const pending = new Map<StoreName, Map<string, unknown | null>>();
    const cleared = new Set<StoreName>();
    const writable = () => {
      if (mode !== "readwrite") throw new Error("readonly transaction");
    };
    const pend = (store: StoreName) => {
      let p = pending.get(store);
      if (!p) {
        p = new Map();
        pending.set(store, p);
      }
      return p;
    };
    // Point lookups are O(1): pending writes first, then the committed table. Only scans
    // (all/where) build a merged view. Copying the table per lookup made bulk inserts
    // quadratic (≈10 min to validate a 140k-record backup).
    const lookup = (store: StoreName, id: string): unknown | undefined => {
      const p = pending.get(store);
      if (p?.has(id)) return p.get(id) ?? undefined;
      if (cleared.has(store)) return undefined;
      return this.table(store).get(id);
    };
    const current = (store: StoreName): Iterable<unknown> => {
      const p = pending.get(store);
      if (!p?.size) return cleared.has(store) ? [] : this.table(store).values();
      const merged = new Map(cleared.has(store) ? [] : this.table(store));
      for (const [id, v] of p) {
        if (v === null) merged.delete(id);
        else merged.set(id, v);
      }
      return merged.values();
    };
    const tx: Tx = {
      get: async (store, id) => {
        const v = lookup(store, id);
        return v === undefined ? undefined : structuredClone(v as never);
      },
      all: async (store) => [...current(store)].map((v) => structuredClone(v as never)),
      where: async (store, field, value) => {
        assertIndexed(store, field);
        return [...current(store)].filter((v) => (v as Record<string, unknown>)[field] === value).map((v) => structuredClone(v as never));
      },
      put: async (store, value) => {
        writable();
        pend(store).set((value as { id: string }).id, structuredClone(value));
      },
      add: async (store, value) => {
        writable();
        const id = (value as { id: string }).id;
        if (lookup(store, id) !== undefined) throw new DomainError("exists", { store, id });
        pend(store).set(id, structuredClone(value));
      },
      delete: async (store, id) => {
        writable();
        pend(store).set(id, null);
      },
      clear: async (store) => {
        writable();
        cleared.add(store);
        pending.delete(store);
      },
    };
    const result = await fn(tx);
    if (mode === "readwrite") {
      if (this.failNextCommit) {
        const e = this.failNextCommit;
        this.failNextCommit = null;
        throw e;
      }
      for (const store of cleared) this.table(store).clear();
      for (const [store, rows] of pending) {
        const t = this.table(store);
        for (const [id, v] of rows) {
          if (v === null) t.delete(id);
          else t.set(id, v);
        }
      }
    }
    return result;
  }
}

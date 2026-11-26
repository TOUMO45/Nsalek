// IndexedDB implementation of the transactional Store. One read-write transaction spans all
// stores so commands serialize across tabs. Errors (quota, I/O) abort the whole transaction
// and are reported to the caller; the UI says "saved" only after `oncomplete`.
import { INDEXES, type Store, type Tx } from "../core/store.ts";
import { ALL_STORES, DomainError, type StoreName } from "../core/types.ts";

export const DB_NAME = "nsalek";
export const DB_VERSION = 2;

/** Versioned, additive schema upgrades. Never delete user data in an upgrade. */
function upgrade(db: IDBDatabase, tx: IDBTransaction, oldVersion: number) {
  if (oldVersion < 1) {
    for (const name of ALL_STORES) {
      const os = db.createObjectStore(name, { keyPath: "id" });
      for (const field of INDEXES[name] ?? []) os.createIndex(field, field, { unique: false });
    }
  }
  // Version 2: the cash book. A store created at version 1 already has it (ALL_STORES).
  if (oldVersion >= 1 && oldVersion < 2 && !db.objectStoreNames.contains("cashEntries")) {
    const os = db.createObjectStore("cashEntries", { keyPath: "id" });
    for (const field of INDEXES.cashEntries ?? []) os.createIndex(field, field, { unique: false });
  }
  // Future versions: `if (oldVersion < 3) { ... }` adding stores/indexes only.
  void tx;
}

export function openDatabase(name = DB_NAME, factory: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!factory) return reject(new DomainError("storage_unavailable"));
    const req = factory.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, req.transaction!, e.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new DomainError("storage_unavailable"));
    req.onblocked = () => reject(new DomainError("storage_blocked"));
  });
}

export class IdbStore implements Store {
  private db: IDBDatabase;
  constructor(db: IDBDatabase) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  run<T>(mode: "readonly" | "readwrite", fn: (tx: Tx) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let t: IDBTransaction;
      try {
        t = this.db.transaction(ALL_STORES, mode, { durability: "strict" });
      } catch (e) {
        reject(e);
        return;
      }
      let result: T;
      let failure: unknown = null;
      const request = <R>(r: IDBRequest<R>, map?: (e: DOMException | null) => unknown) =>
        new Promise<R>((res, rej) => {
          r.onsuccess = () => res(r.result);
          r.onerror = (ev) => {
            // Let the handler decide; the runner aborts the transaction if it rethrows.
            ev.preventDefault();
            ev.stopPropagation();
            rej(map ? map(r.error) : r.error);
          };
        });
      const os = (name: StoreName) => t.objectStore(name);
      const tx: Tx = {
        get: (store, id) => request(os(store).get(id)) as never,
        all: (store) => request(os(store).getAll()) as never,
        where: (store, field, value) => {
          if (!INDEXES[store]?.includes(field)) throw new Error(`no index ${store}.${field}`);
          return request(os(store).index(field).getAll(value)) as never;
        },
        put: async (store, value) => {
          await request(os(store).put(value));
        },
        add: async (store, value) => {
          await request(os(store).add(value), (e) =>
            e?.name === "ConstraintError" ? new DomainError("exists", { store, id: (value as { id: string }).id }) : e,
          );
        },
        delete: async (store, id) => {
          await request(os(store).delete(id));
        },
        clear: async (store) => {
          await request(os(store).clear());
        },
      };
      t.oncomplete = () => (failure ? reject(failure) : resolve(result));
      t.onabort = () => reject(failure ?? t.error ?? new DomainError("transaction_aborted"));
      fn(tx).then(
        (r) => {
          result = r;
        },
        (e) => {
          failure = e;
          try {
            t.abort();
          } catch {
            reject(e);
          }
        },
      );
    });
  }
}

export async function openStore(name = DB_NAME, factory?: IDBFactory): Promise<IdbStore> {
  return new IdbStore(await openDatabase(name, factory));
}

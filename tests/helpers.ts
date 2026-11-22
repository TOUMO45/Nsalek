import { execute, type CommandOutcome } from "../lib/core/commands.ts";
import { buildIndex } from "../lib/core/ledger.ts";
import { MemoryStore, type Store } from "../lib/core/store.ts";
import { DATA_STORES, emptyLedger, type LedgerData } from "../lib/core/types.ts";

export const NOW = new Date("2026-11-22T10:00:00Z"); // 11:00 in Africa/Algiers
export const TODAY = "2026-11-22";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type R = any;

let counter = 0;
export const nextId = () => `cmd${++counter}_${Math.random().toString(36).slice(2, 8)}`;

export async function loadAll(store: Store): Promise<LedgerData> {
  const data = emptyLedger();
  await store.run("readonly", async (tx) => {
    for (const s of DATA_STORES) data[s] = (await tx.all(s)) as never;
  });
  return data;
}

export function harness(store: Store = new MemoryStore(), clock: () => Date = () => NOW) {
  const raw = (type: string, payload: Record<string, unknown>, id = nextId()): Promise<CommandOutcome<R>> =>
    execute<R>(store, { id, type, payload }, clock);
  const run = async (type: string, payload: Record<string, unknown>, id?: string): Promise<R> => (await raw(type, payload, id)).result;
  const index = async (workspaceId: string) => buildIndex(await loadAll(store), workspaceId);
  return { store, raw, run, index };
}

/** Workspace "Test" (DZD, Africa/Algiers) with one person "Karim". */
export async function basic(store?: Store, clock?: () => Date) {
  const h = harness(store, clock);
  const { workspaceId } = await h.run("createWorkspace", { name: "Test" });
  const { partyId } = await h.run("createParty", { workspaceId, displayName: "Karim" });
  return { ...h, workspaceId, partyId };
}

export const DA = (n: number) => Math.round(n * 100);

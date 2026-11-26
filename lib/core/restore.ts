// Restore and merge. A backup is validated in a temporary in-memory store first; active data is
// replaced only after validation passes, inside one transaction, after a pre-restore snapshot.
import { BackupError, canonical, createBackup, manifestMatches, openBackup, serializeBackup, validateLedger, type BackupFile } from "./backup.ts";
import { MemoryStore, type Store, type Tx } from "./store.ts";
import { DATA_STORES, emptyLedger, type LedgerData } from "./types.ts";

export async function readAll(tx: Tx): Promise<LedgerData> {
  const data = emptyLedger();
  for (const s of DATA_STORES) data[s] = (await tx.all(s)) as never;
  return data;
}

export async function loadLedger(store: Store): Promise<LedgerData> {
  return store.run("readonly", readAll);
}

export type RestorePlan = { data: LedgerData; issues: ReturnType<typeof validateLedger>; manifestOk: boolean };

/** Opens, verifies and validates a backup without touching active data. */
export async function prepareRestore(file: BackupFile, passphrase?: string): Promise<RestorePlan> {
  const data = await openBackup(file, passphrase);
  // Load into a temporary store so the same storage path used by the app is exercised.
  const temp = new MemoryStore();
  await temp.run("readwrite", async (tx) => {
    for (const s of DATA_STORES) for (const r of data[s] as never[]) await tx.add(s, r);
  });
  const reloaded = await loadLedger(temp);
  return { data: reloaded, issues: validateLedger(reloaded), manifestOk: manifestMatches(file, reloaded) };
}

export type RestoreResult = { mode: "replace" | "merge"; snapshotId: string; added: number; skipped: number; conflicts: { store: string; id: string }[] };

async function snapshot(store: Store, reason: string, now: Date): Promise<{ id: string; text: string }> {
  const current = await loadLedger(store);
  const text = serializeBackup(await createBackup(current, { now }));
  return { id: `snap_${now.getTime()}`, text };
}

export async function restoreBackup(
  store: Store,
  file: BackupFile,
  opts: { mode: "replace" | "merge"; passphrase?: string; now?: Date },
): Promise<RestoreResult> {
  const now = opts.now ?? new Date();
  const plan = await prepareRestore(file, opts.passphrase);
  if (plan.issues.length) throw new BackupError("validation_failed", plan.issues.slice(0, 50));
  if (!plan.manifestOk) throw new BackupError("manifest_mismatch");
  const snap = await snapshot(store, opts.mode, now);
  return store.run("readwrite", async (tx) => {
    await tx.put("snapshots", { id: snap.id, createdAt: now.toISOString(), reason: `before ${opts.mode}`, backup: snap.text });
    if (opts.mode === "replace") {
      let added = 0;
      for (const s of DATA_STORES) {
        await tx.clear(s);
        for (const r of plan.data[s] as never[]) {
          await tx.put(s, r);
          added++;
        }
      }
      // This is another notebook now: the account's copy is not replaced by it without asking.
      const meta = await tx.get("meta", "app");
      if (meta?.cloud) await tx.put("meta", { ...meta, cloud: { ...meta.cloud, link: undefined, pendingId: undefined, pin: undefined, epoch: crypto.randomUUID() } });
      return { mode: "replace", snapshotId: snap.id, added, skipped: 0, conflicts: [] };
    }
    // Merge: add unknown ids, skip identical records, never overwrite a different record.
    const current = await readAll(tx);
    const merged = emptyLedger();
    const conflicts: RestoreResult["conflicts"] = [];
    const additions: { store: (typeof DATA_STORES)[number]; row: unknown }[] = [];
    let skipped = 0;
    for (const s of DATA_STORES) {
      const byId = new Map((current[s] as { id: string }[]).map((r) => [r.id, r]));
      merged[s] = [...(current[s] as never[])] as never;
      for (const r of plan.data[s] as { id: string }[]) {
        const existing = byId.get(r.id);
        if (!existing) {
          additions.push({ store: s, row: r });
          (merged[s] as unknown[]).push(r);
        } else if (canonical(existing) === canonical(r)) skipped++;
        else conflicts.push({ store: s, id: r.id });
      }
    }
    const issues = validateLedger(merged);
    if (issues.length) throw new BackupError("merge_validation_failed", issues.slice(0, 50));
    for (const a of additions) await tx.add(a.store, a.row as never);
    return { mode: "merge", snapshotId: snap.id, added: additions.length, skipped, conflicts };
  });
}

// Three-way comparison of two phones with their last common copy. Money is never guessed: what
// changed on both sides in different ways is reported, not decided.
import { canonical, validateLedger } from "../core/backup.ts";
import { occurrencesUntil } from "../core/recurrence.ts";
import { DATA_STORES, emptyLedger, type LedgerData, type Workspace } from "../core/types.ts";

export type Conflict = { store: string; id: string };
/** `conflicts`: cannot be combined. `doubts`: can be, if a person says so (something to check afterwards). */
export type Merged = { data: LedgerData; conflicts: Conflict[]; doubts: Conflict[] };

type Row = { id: string; createdAt?: string; updatedAt?: string };

/** Same record, written by both phones at different times (for example the month's recurring debt). */
function sameButForTimes(a: Row, b: Row): Row | null {
  const bare = (r: Row) => canonical({ ...r, createdAt: undefined, updatedAt: undefined });
  if (bare(a) !== bare(b)) return null;
  return (a.createdAt ?? "") <= (b.createdAt ?? "") ? a : b;
}

/** Each phone moves the next receipt and invoice numbers forward; that alone is not a disagreement. */
function sameButForNumbers(mine: Workspace, theirs: Workspace, common: Workspace): Workspace | null {
  const bare = (w: Workspace) =>
    canonical({ ...w, updatedAt: undefined, settings: { ...w.settings, receipts: { ...w.settings.receipts, nextNumber: 0 }, invoices: { ...w.settings.invoices, nextNumber: 0 } } });
  const [m, t, c] = [bare(mine), bare(theirs), bare(common)];
  if (m !== t && m !== c && t !== c) return null;
  const keep = m === c ? theirs : mine;
  const next = <K extends "receipts" | "invoices">(k: K) => ({ ...keep.settings[k], nextNumber: Math.max(mine.settings[k].nextNumber, theirs.settings[k].nextNumber) });
  return { ...keep, settings: { ...keep.settings, receipts: next("receipts"), invoices: next("invoices") } };
}

export function threeWay(base: LedgerData | null, local: LedgerData, remote: LedgerData): Merged {
  const data = emptyLedger();
  const conflicts: Conflict[] = [];
  const doubts: Conflict[] = [];
  for (const store of DATA_STORES) {
    const map = (d: LedgerData | null) => new Map(((d?.[store] ?? []) as Row[]).map((r) => [r.id, r]));
    const [b, l, r] = [map(base), map(local), map(remote)];
    const out: Row[] = [];
    for (const id of new Set([...l.keys(), ...r.keys()])) {
      const [mine, theirs, common] = [l.get(id), r.get(id), b.get(id)];
      const key = (x: Row | undefined) => (x ? canonical(x) : "");
      const [km, kt, kc] = [key(mine), key(theirs), key(common)];
      let keep: Row | undefined;
      if (km === kt) keep = mine;
      else if (common) {
        if (km === kc) keep = theirs;
        else if (kt === kc) keep = mine;
        else {
          const numbered = store === "workspaces" && mine && theirs ? sameButForNumbers(mine as Workspace, theirs as Workspace, common as Workspace) : null;
          if (numbered) keep = numbered;
          else conflicts.push({ store, id });
        }
      } else if (!mine || !theirs) keep = mine ?? theirs;
      else {
        const same = sameButForTimes(mine, theirs);
        if (same) keep = same;
        else conflicts.push({ store, id });
      }
      if (keep) out.push(keep);
    }
    data[store] = out as never;
  }
  if (!conflicts.length) {
    for (const i of validateLedger(data)) conflicts.push({ store: i.store ?? "ledger", id: i.id ?? i.code });
    // What is already so on one of the phones was not made by combining, and must not block it forever.
    const before = new Set([...problems(local).keys(), ...problems(remote).keys()]);
    for (const [key, c] of problems(data)) if (!before.has(key)) (key.startsWith("check|") ? doubts : conflicts).push(c);
  }
  return { data, conflicts, doubts };
}

/** Names of the people a conflict is about, to show before choosing. */
export function peopleIn(conflicts: Conflict[], ...sides: LedgerData[]): string[] {
  const names = new Set<string>();
  for (const { store, id } of conflicts)
    for (const d of sides) {
      const row = ((d[store as keyof LedgerData] ?? []) as { id: string; partyId?: string; obligationId?: string }[]).find((r) => r.id === id);
      if (!row) continue;
      const partyId = store === "parties" ? id : (row.partyId ?? d.obligations.find((o) => o.id === row.obligationId)?.partyId);
      const name = d.parties.find((p) => p.id === partyId)?.displayName;
      if (name) names.add(name);
    }
  return [...names];
}

/**
 * Right on each phone, wrong together: what the ledger checks do not see, by a key that says which.
 * "check|": nothing is hidden or contradicted, a person may keep both and cancel what is too much.
 */
function problems(data: LedgerData): Map<string, Conflict> {
  const out = new Map<string, Conflict>();
  const flag = (why: string, store: string, id: string) => out.set(`${why}|${store}|${id}`, { store, id });
  // An entry added to a person whom the other phone merged into somebody else would be hidden.
  const merged = new Set(data.parties.filter((p) => p.mergedIntoId).map((p) => p.id));
  for (const store of ["obligations", "payments", "allocations", "adjustments", "promises", "installmentPlans", "recurringPlans", "invoices"] as const)
    for (const r of data[store]) if (merged.has(r.partyId)) flag("merged", store, r.id);
  const debts = new Map(data.obligations.map((o) => [o.id, o]));
  const on = (store: string, r: { id: string; obligationId?: string | null; partyId: string }, active: boolean) => {
    const debt = r.obligationId ? debts.get(r.obligationId) : undefined;
    if (!debt) return;
    if (debt.partyId !== r.partyId) flag("person", store, r.id);
    // Changed on one phone (also taken back), cancelled or replaced on the other: the change would vanish with it.
    if (debt.state === "voided") flag(active ? "voided" : "voided, taken back", store, r.id);
  };
  for (const r of data.adjustments) on("adjustments", r, !r.reversedAt);
  for (const r of data.allocations) on("allocations", r, !r.reversedAt);
  for (const r of data.installmentPlans) on("installmentPlans", r, r.state === "active");
  for (const r of data.invoices) on("invoices", r, r.state === "posted");
  // A debt added to a person whom the other phone put in the archive.
  const archived = new Set(data.parties.filter((p) => p.archivedAt && !p.mergedIntoId).map((p) => p.id));
  for (const o of data.obligations) if (o.state === "posted" && archived.has(o.partyId)) flag("check|archived", "obligations", o.id);
  // A period made on one phone of a plan that the other ended or paused before it.
  for (const plan of data.recurringPlans) {
    const made = data.obligations.filter((o) => o.recurringPlanId === plan.id && o.state === "posted");
    if (!made.length) continue;
    const due = new Set(occurrencesUntil(plan, made.reduce((m, o) => (o.date > m ? o.date : m), "")).map((x) => x.obligationId));
    for (const o of made) if (!due.has(o.id)) flag("check|period", "obligations", o.id);
  }
  // Only one of each: a debt's active plan, a receipt or invoice number, an imported line.
  const count = new Map<string, number>();
  const once = (store: string, id: string, key: string, why = "check|twice") => {
    const n = (count.get(key) ?? 0) + 1;
    count.set(key, n);
    if (n > 1) out.set(`${why}|${key}|${n}`, { store, id });
  };
  for (const p of data.installmentPlans) if (p.state === "active") once("installmentPlans", p.id, `plan|${p.obligationId}`, "twice");
  for (const p of data.payments) {
    if (p.receiptNumber) once("payments", p.id, `receipt|${p.workspaceId}|${p.receiptNumber}`);
    if (p.importFingerprint && p.state === "posted") once("payments", p.id, `import|${p.workspaceId}|${p.importFingerprint}`);
  }
  for (const o of data.obligations) if (o.importFingerprint && o.state !== "voided") once("obligations", o.id, `import|${o.workspaceId}|${o.importFingerprint}`);
  for (const i of data.invoices) if (i.number) once("invoices", i.id, `invoice|${i.workspaceId}|${i.number}`);
  return out;
}

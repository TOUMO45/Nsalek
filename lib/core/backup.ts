// Versioned backups: manifest with counts and totals, sha256 integrity over a canonical JSON
// payload, optional AES-GCM encryption, and a validator used before any restore.
import { decryptText, encryptText, sha256Hex, type Envelope } from "./crypto.ts";
import { activeAllocations, buildIndex, figuresOf, paymentFiguresOf, workspaceTotals } from "./ledger.ts";
import { todayIn } from "./dates.ts";
import { DATA_STORES, emptyLedger, type DataStore, type LedgerData } from "./types.ts";

export const BACKUP_FORMAT = "nsalek-backup";
export const SCHEMA_VERSION = 1;

export type ManifestTotals = { workspaceId: string; currency: string; receivable: number; payable: number; advanceReceived: number; advancePaid: number };

export type Manifest = {
  counts: Record<DataStore, number>;
  totals: ManifestTotals[];
  payloadSha256: string;
  attachments: { included: number; bytes: number; omitted: string[] };
};

export type BackupFile = {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  createdAt: string;
  app: { name: string; version: string };
  scope: { workspaceIds: string[] };
  manifest: Manifest;
  encryption: Envelope | null;
  payload: LedgerData | string;
};

/** JSON with sorted object keys, so the same data always hashes the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(obj[k]))
      .join(",") +
    "}"
  );
}

export function filterWorkspaces(data: LedgerData, workspaceIds?: string[]): LedgerData {
  if (!workspaceIds) return data;
  const keep = new Set(workspaceIds);
  const out = emptyLedger();
  for (const s of DATA_STORES) {
    out[s] = (data[s] as { id: string; workspaceId?: string }[]).filter((r) => (s === "workspaces" ? keep.has(r.id) : keep.has(r.workspaceId!))) as never;
  }
  return out;
}

export function sortLedger(data: LedgerData): LedgerData {
  const out = emptyLedger();
  for (const s of DATA_STORES) out[s] = [...(data[s] as { id: string }[])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) as never;
  return out;
}

export function computeTotals(data: LedgerData, at = new Date()): ManifestTotals[] {
  const out: ManifestTotals[] = [];
  for (const ws of [...data.workspaces].sort((a, b) => a.id.localeCompare(b.id))) {
    const idx = buildIndex(data, ws.id);
    for (const [currency, t] of [...workspaceTotals(idx, todayIn(ws.timezone, at))].sort((a, b) => a[0].localeCompare(b[0])))
      out.push({ workspaceId: ws.id, currency, receivable: t.receivable, payable: t.payable, advanceReceived: t.advanceReceived, advancePaid: t.advancePaid });
  }
  return out;
}

export async function createBackup(
  all: LedgerData,
  opts: { workspaceIds?: string[]; passphrase?: string; now?: Date; appVersion?: string; iterations?: number } = {},
): Promise<BackupFile> {
  const now = opts.now ?? new Date();
  const data = sortLedger(filterWorkspaces(all, opts.workspaceIds));
  const json = canonical(data);
  const counts = Object.fromEntries(DATA_STORES.map((s) => [s, data[s].length])) as Record<DataStore, number>;
  const manifest: Manifest = {
    counts,
    totals: computeTotals(data, now),
    payloadSha256: await sha256Hex(json),
    attachments: { included: data.attachments.length, bytes: data.attachments.reduce((n, a) => n + a.size, 0), omitted: [] },
  };
  let payload: LedgerData | string = data;
  let encryption: Envelope | null = null;
  if (opts.passphrase) {
    const r = await encryptText(json, opts.passphrase, opts.iterations);
    payload = r.ciphertext;
    encryption = r.envelope;
  }
  return {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    createdAt: now.toISOString(),
    app: { name: "Nsalek", version: opts.appVersion ?? "0.1.0" },
    scope: { workspaceIds: data.workspaces.map((w) => w.id) },
    manifest,
    encryption,
    payload,
  };
}

export function serializeBackup(file: BackupFile): string {
  return JSON.stringify(file);
}

export class BackupError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, details?: unknown) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export function parseBackup(text: string): BackupFile {
  let file: BackupFile;
  try {
    file = JSON.parse(text);
  } catch {
    throw new BackupError("not_a_backup");
  }
  if (!file || file.format !== BACKUP_FORMAT) throw new BackupError("not_a_backup");
  if (typeof file.schemaVersion !== "number" || file.schemaVersion > SCHEMA_VERSION) throw new BackupError("newer_schema", { version: file.schemaVersion });
  if (!file.manifest || typeof file.manifest.payloadSha256 !== "string") throw new BackupError("missing_manifest");
  return file;
}

/** Decrypts (when needed) and verifies integrity. Never touches active data. */
export async function openBackup(file: BackupFile, passphrase?: string): Promise<LedgerData> {
  let json: string;
  if (file.encryption) {
    if (!passphrase) throw new BackupError("passphrase_required");
    if (typeof file.payload !== "string") throw new BackupError("corrupt_backup");
    try {
      json = await decryptText(file.payload, passphrase, file.encryption);
    } catch {
      throw new BackupError("wrong_passphrase");
    }
  } else {
    if (typeof file.payload !== "object" || !file.payload) throw new BackupError("corrupt_backup");
    json = canonical(file.payload);
  }
  if ((await sha256Hex(json)) !== file.manifest.payloadSha256) throw new BackupError("integrity_failed");
  const data = JSON.parse(json) as LedgerData;
  for (const s of DATA_STORES) if (!Array.isArray(data[s])) data[s] = [] as never;
  return data;
}

export type ValidationIssue = { code: string; store?: string; id?: string };

/** Referential and financial invariants. A restore proceeds only when this returns no issues. */
export function validateLedger(data: LedgerData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Map<string, Set<string>>();
  for (const s of DATA_STORES) {
    const set = new Set<string>();
    for (const r of data[s] as { id: string }[]) {
      if (typeof r?.id !== "string") issues.push({ code: "missing_id", store: s });
      else if (set.has(r.id)) issues.push({ code: "duplicate_id", store: s, id: r.id });
      else set.add(r.id);
    }
    ids.set(s, set);
  }
  const has = (s: DataStore, id: string) => ids.get(s)!.has(id);
  const wsOk = (r: { workspaceId: string; id: string }, s: string) => {
    if (!has("workspaces", r.workspaceId)) issues.push({ code: "orphan_workspace", store: s, id: r.id });
  };
  for (const s of DATA_STORES) if (s !== "workspaces") for (const r of data[s] as { workspaceId: string; id: string }[]) wsOk(r, s);
  for (const o of data.obligations) if (!has("parties", o.partyId)) issues.push({ code: "orphan_party", store: "obligations", id: o.id });
  for (const p of data.payments) if (!has("parties", p.partyId)) issues.push({ code: "orphan_party", store: "payments", id: p.id });
  const obById = new Map(data.obligations.map((o) => [o.id, o]));
  const payById = new Map(data.payments.map((p) => [p.id, p]));
  for (const a of data.allocations) {
    const ob = obById.get(a.obligationId);
    const pay = payById.get(a.paymentId);
    if (!ob || !pay) {
      issues.push({ code: "orphan_allocation", store: "allocations", id: a.id });
      continue;
    }
    if (a.reversedAt) continue;
    if (ob.direction !== pay.direction || ob.currency !== pay.currency || ob.workspaceId !== pay.workspaceId || ob.partyId !== pay.partyId)
      issues.push({ code: "incompatible_allocation", store: "allocations", id: a.id });
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0) issues.push({ code: "invalid_amount", store: "allocations", id: a.id });
  }
  for (const adj of data.adjustments) if (!obById.has(adj.obligationId)) issues.push({ code: "orphan_adjustment", store: "adjustments", id: adj.id });
  for (const ws of data.workspaces) {
    const idx = buildIndex(data, ws.id);
    for (const ob of idx.obligation.values()) {
      if (!Number.isSafeInteger(ob.principal) || ob.principal <= 0) issues.push({ code: "invalid_amount", store: "obligations", id: ob.id });
      if (figuresOf(idx, ob).outstanding < 0) issues.push({ code: "negative_outstanding", store: "obligations", id: ob.id });
      if (ob.state === "voided" && activeAllocations(idx.allocByOb.get(ob.id)).length) issues.push({ code: "voided_with_payments", store: "obligations", id: ob.id });
    }
    for (const p of idx.payment.values()) {
      if (!Number.isSafeInteger(p.amount) || p.amount <= 0) issues.push({ code: "invalid_amount", store: "payments", id: p.id });
      if (paymentFiguresOf(idx, p).unallocated < 0) issues.push({ code: "overallocated_payment", store: "payments", id: p.id });
      if (p.state === "reversed" && activeAllocations(idx.allocByPay.get(p.id)).length) issues.push({ code: "reversed_with_allocations", store: "payments", id: p.id });
    }
  }
  return issues;
}

/** Recomputes totals and compares them to the manifest. */
export function manifestMatches(file: BackupFile, data: LedgerData, at?: Date): boolean {
  const counts = DATA_STORES.every((s) => (file.manifest.counts[s] ?? 0) === data[s].length);
  return counts && canonical(computeTotals(data, at ?? new Date(file.createdAt))) === canonical(file.manifest.totals);
}

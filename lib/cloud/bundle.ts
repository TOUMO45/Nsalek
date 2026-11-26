// What goes to the cloud: every real notebook, without photos, as one compressed and checksummed
// file in the same format as a backup.
import { BackupError, canonical, createBackup, filterWorkspaces, manifestMatches, openBackup, parseBackup, serializeBackup, sortLedger, validateLedger } from "../core/backup.ts";
import type { LedgerData } from "../core/types.ts";

export type Encoding = "gzip" | "none";
export type Packed = { bytes: Uint8Array<ArrayBuffer>; encoding: Encoding; sha: string; schemaVersion: number; people: number; entries: number };

/** The part of the data the cloud keeps: real notebooks only, no photos. */
export function cloudView(data: LedgerData): LedgerData {
  const real = data.workspaces.filter((w) => !w.demo).map((w) => w.id);
  return { ...sortLedger(filterWorkspaces(data, real)), attachments: [] };
}

/** One text for one state, to notice any change. */
export const fingerprint = (data: LedgerData) => canonical(cloudView(data));

/** No notebook, or only empty ones (a notebook just made at the first start). */
export function isBlank(view: LedgerData): boolean {
  return ![view.parties, view.obligations, view.payments, view.notes, view.recurringPlans, view.invoices].some((l) => l.length > 0);
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: GenericTransformStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>>)).arrayBuffer());
}

export async function pack(data: LedgerData, opts: { now: Date; appVersion?: string }): Promise<Packed> {
  const view = cloudView(data);
  const file = await createBackup(view, { now: opts.now, appVersion: opts.appVersion });
  const raw = new TextEncoder().encode(serializeBackup(file)) as Uint8Array<ArrayBuffer>;
  // Old browsers cannot compress; the copy is then larger but just as good.
  const gzip = typeof CompressionStream !== "undefined";
  return {
    bytes: gzip ? await pipe(raw, new CompressionStream("gzip")) : raw,
    encoding: gzip ? "gzip" : "none",
    sha: file.manifest.payloadSha256,
    schemaVersion: file.schemaVersion,
    people: view.parties.filter((p) => !p.mergedIntoId).length,
    entries: view.obligations.length + view.payments.length,
  };
}

/** Opens a copy and refuses it unless it is whole and its ledger is consistent. */
export async function unpack(bytes: Uint8Array<ArrayBuffer>, encoding: Encoding): Promise<{ data: LedgerData; sha: string }> {
  let text: string;
  try {
    if (encoding === "gzip" && typeof DecompressionStream === "undefined") throw new BackupError("cloud_update_app");
    text = new TextDecoder("utf-8", { fatal: true }).decode(encoding === "gzip" ? await pipe(bytes, new DecompressionStream("gzip")) : bytes);
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError("cloud_corrupt");
  }
  const file = parseBackup(text);
  const data = await openBackup(file);
  const issues = validateLedger(data);
  if (issues.length) throw new BackupError("cloud_corrupt", issues.slice(0, 20));
  if (!manifestMatches(file, data)) throw new BackupError("cloud_corrupt");
  return { data, sha: file.manifest.payloadSha256 };
}

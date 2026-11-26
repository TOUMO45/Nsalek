// A second copy of the notebook in the person's own Google Drive, photos included. It is a backup,
// not a sync: each phone adds its own copies, never changes another phone's, and a copy is put back
// through the same checked restore as a backup file (core/restore.ts).
import { createBackup, openBackup, parseBackup, serializeBackup, validateLedger, type BackupFile } from "../core/backup.ts";
import { sha256Hex } from "../core/crypto.ts";
import { isoWeekKey, todayIn } from "../core/dates.ts";
import { loadLedger } from "../core/restore.ts";
import type { Store } from "../core/store.ts";
import { DATA_STORES, type LedgerData } from "../core/types.ts";
import { DriveError, type DriveFile, type DrivePort } from "./port.ts";

export const APP = "nsalek";

/** What the list shows, and what the keeping rule weighs, without opening a copy (its labels). */
export type CopyInfo = {
  id: string;
  at: string;
  device: string;
  deviceName: string;
  bytes: number;
  encoding: "gzip" | "none";
  sha: string;
  people: number;
  entries: number;
  photos: number;
  /** Every row of every real notebook. */
  records: number;
  /** Audit events inside, and the time of the last one: what any later state should still hold. */
  audit: number;
  last: string;
  /** Short marks of the notebooks inside. */
  books: string[];
  /** The copy just before this one, when the phone had lost something it held (kept with this one). */
  holds: string;
};

const NEWEST = 3;
const DAYS = 7;
const WEEKS = 4;
const MONTHS = 6;
/** Copies kept for a loss (each loss: the copy before it and the copy that names it), newest first. */
const MAX_HELD = 40;

const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : 0);

/** A short, stable mark for a notebook id (FNV-1a), to fit Google's label size. */
export function bookMark(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return (h % 36 ** 5).toString(36);
}

export function infoOf(f: DriveFile): CopyInfo | null {
  const p = f.appProperties ?? {};
  if (p.app !== APP || !p.dev || !p.at || !p.sha) return null;
  return {
    id: f.id,
    at: p.at,
    device: p.dev,
    deviceName: p.devname ?? "",
    bytes: f.size,
    encoding: p.enc === "gzip" ? "gzip" : "none",
    sha: p.sha,
    people: num(p.people),
    entries: num(p.entries),
    photos: num(p.photos),
    records: num(p.records),
    audit: num(p.audit),
    last: p.last ?? "",
    books: (p.books ?? "").split(",").filter(Boolean),
    holds: p.holds ?? "",
  };
}

/** Every copy, newest first. Files that are not Nsalek copies are left alone. */
export async function listCopies(drive: DrivePort): Promise<CopyInfo[]> {
  return (await drive.list())
    .map(infoOf)
    .filter((c): c is CopyInfo => !!c)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
}

/**
 * Copies of one phone to remove once `currentId` is its newest. By age, as the cloud copy: newest 3,
 * last of 7 days, 4 weeks, 6 months. Whatever its age, each loss: the copy before it and the copy
 * that names it (`holds`, written with that copy, so no later request can lose it); the newest
 * forty of those. And always the copy with the most records, the one with the most photos, and the
 * newest copy of each notebook ever copied.
 */
export function copiesToDrop(copies: CopyInfo[], currentId: string): CopyInfo[] {
  const list = [...copies].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const keep = new Set([currentId, ...list.slice(0, NEWEST).map((c) => c.id)]);
  const lastOf = (key: (c: CopyInfo) => string, limit: number) => {
    const seen = new Set<string>();
    for (const c of list) {
      const k = key(c);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(c.id);
    }
  };
  const day = (c: CopyInfo) => todayIn(undefined, new Date(c.at));
  lastOf(day, DAYS);
  lastOf((c) => isoWeekKey(day(c)), WEEKS);
  lastOf((c) => day(c).slice(0, 7), MONTHS);

  const named = new Set(list.map((c) => c.holds).filter(Boolean));
  list
    .filter((c) => c.holds || named.has(c.id))
    .slice(0, MAX_HELD)
    .forEach((c) => keep.add(c.id));
  const always = new Set<string>();
  const most = (key: (c: CopyInfo) => number) => list.reduce<CopyInfo | null>((best, c) => (!best || key(c) > key(best) ? c : best), null);
  for (const c of [most((c) => c.records), most((c) => c.photos)]) if (c) always.add(c.id);
  const lastBook = new Set<string>();
  for (const c of list)
    for (const b of c.books)
      if (!lastBook.has(b)) {
        lastBook.add(b);
        always.add(c.id);
      }
  for (const id of always) keep.add(id);
  return list.filter((c) => !keep.has(c.id));
}

async function through(bytes: Uint8Array<ArrayBuffer>, stream: GenericTransformStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>>)).arrayBuffer());
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

const realIds = (data: LedgerData) => new Set(data.workspaces.filter((w) => !w.demo).map((w) => w.id));

/**
 * What a copy of this state would hold, cheap enough to compute after every change: counts of the
 * real notebooks' rows and photos, and the last audit event. null when there is nothing to copy.
 * A different signature means the newest copy no longer holds everything (a restore and a pull
 * from the account count too, which audit times alone would miss).
 */
export function signature(data: LedgerData): string | null {
  const real = realIds(data);
  let rows = 0;
  let content = 0;
  const parts: number[] = [];
  for (const s of DATA_STORES) {
    let n = 0;
    for (const r of data[s] as { id: string; workspaceId?: string }[]) if (s === "workspaces" ? real.has(r.id) : real.has(r.workspaceId!)) n++;
    parts.push(n);
    rows += n;
    if (s === "parties" || s === "obligations" || s === "payments" || s === "notes" || s === "recurringPlans" || s === "invoices") content += n;
  }
  if (!content) return null;
  let last = "";
  for (const e of data.audit) if (real.has(e.workspaceId) && e.at > last) last = e.at;
  return `${rows}|${parts.join(".")}|${last}`;
}

/**
 * Does the phone lack something that copy `prev` holds? Audit events and photos only ever pile up
 * (a pull from the account adds older ones too), so fewer of them up to `prev`'s last event means
 * something left: a restore over the notebook, a notebook removed, a photo removed. Counting only
 * what dates from `prev` keeps new entries from hiding the loss.
 */
export function lostSince(prev: CopyInfo, data: LedgerData): boolean {
  const real = realIds(data);
  const books = new Set([...real].map(bookMark));
  if (prev.books.some((b) => !books.has(b))) return true;
  if (!prev.last) return false;
  let audit = 0;
  for (const e of data.audit) if (real.has(e.workspaceId) && e.at <= prev.last) audit++;
  let photos = 0;
  for (const a of data.attachments) if (real.has(a.workspaceId) && a.createdAt <= prev.last) photos++;
  return audit < prev.audit || photos < prev.photos;
}

/** Settings saved before signatures: has a real notebook an audit event since `at`? */
export function changedSince(data: LedgerData, at: string | null | undefined): boolean {
  if (signature(data) === null) return false;
  if (!at) return true;
  const real = realIds(data);
  // ">=": an entry in the same millisecond may have missed the copy.
  return data.audit.some((e) => real.has(e.workspaceId) && e.at >= at);
}

export type Made = { name: string; bytes: Uint8Array<ArrayBuffer>; props: Record<string, string>; file: BackupFile; signature: string };

/** Every real notebook with its photos, reopened exactly as a restore would before it leaves. */
export async function makeCopy(data: LedgerData, opts: { now: Date; device: string; deviceName?: string; appVersion?: string }): Promise<Made> {
  const real = [...realIds(data)];
  const file = await createBackup(data, { workspaceIds: real, now: opts.now, appVersion: opts.appVersion });
  const text = serializeBackup(file);
  const opened = await openBackup(parseBackup(text));
  if (validateLedger(opened).length) throw new DriveError("drive_invalid");
  const raw = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  const gzip = typeof CompressionStream !== "undefined";
  const bytes = gzip ? await through(raw, new CompressionStream("gzip")) : raw;
  const counts = file.manifest.counts;
  // Google keeps at most 124 bytes per label: about a dozen notebooks.
  let books = "";
  for (const id of [...file.scope.workspaceIds].sort()) {
    const next = books ? `${books},${bookMark(id)}` : bookMark(id);
    if (next.length > 115) break; // about twenty notebooks
    books = next;
  }
  let last = "";
  for (const e of opened.audit) if (e.at > last) last = e.at;
  const props = {
    app: APP,
    v: "1",
    dev: opts.device,
    devname: (opts.deviceName ?? "").slice(0, 40),
    at: file.createdAt,
    enc: gzip ? "gzip" : "none",
    sha: await sha256Hex(bytes),
    people: String(opened.parties.filter((p) => !p.mergedIntoId).length),
    entries: String(counts.obligations + counts.payments),
    photos: String(counts.attachments),
    records: String(Object.values(counts).reduce((n, c) => n + c, 0)),
    audit: String(counts.audit),
    last,
    books,
  };
  return { name: `nsalek-${stamp(opts.now)}-${opts.device.slice(0, 8)}.json${gzip ? ".gz" : ""}`, bytes, props, file, signature: signature(data) ?? "" };
}

export type SaveResult = { kind: "empty" } | { kind: "saved"; copy: CopyInfo; dropped: number; signature: string };

/**
 * Sends a new copy, then removes this phone's copies that the rule no longer keeps. Nothing is
 * removed before the new copy is in Drive whole, and no other phone's copy is ever removed.
 */
export async function saveCopy(drive: DrivePort, store: Store, opts: { now?: Date; device: string; deviceName?: string; appVersion?: string }): Promise<SaveResult> {
  // Taken before reading: an entry saved meanwhile still counts as not copied.
  const now = opts.now ?? new Date();
  const data = await loadLedger(store);
  if (signature(data) === null) return { kind: "empty" };
  // Asked first: without a connection, the copy is not even made.
  const before = (await listCopies(drive)).filter((c) => c.device === opts.device);
  const made = await makeCopy(data, { ...opts, now });
  // Named in the new copy's own labels, sent in the same request: nothing later can undo it.
  const prev = before[0];
  const props = prev && lostSince(prev, data) ? { ...made.props, holds: prev.id } : made.props;
  const sent = await drive.upload(made.name, made.bytes, props);
  const copy = infoOf(sent);
  if (!copy || sent.size !== made.bytes.length || copy.sha !== made.props.sha) {
    await drive.remove(sent.id).catch(() => undefined);
    throw new DriveError("drive_failed");
  }
  const drop = copiesToDrop([copy, ...before], copy.id);
  let dropped = 0;
  for (const c of drop) {
    // A copy that could not be removed now is removed after a later save.
    if (await drive.remove(c.id).then(() => true, () => false)) dropped++;
  }
  return { kind: "saved", copy, dropped, signature: made.signature };
}

/** Downloads a copy and refuses it unless it is exactly what was sent. */
export async function readCopy(drive: DrivePort, info: CopyInfo): Promise<BackupFile> {
  const bytes = await drive.download(info.id);
  if ((await sha256Hex(bytes)) !== info.sha) throw new DriveError("drive_damaged");
  let raw = bytes;
  if (info.encoding === "gzip") {
    try {
      raw = await through(bytes, new DecompressionStream("gzip"));
    } catch {
      throw new DriveError("drive_damaged");
    }
  }
  return parseBackup(new TextDecoder().decode(raw));
}

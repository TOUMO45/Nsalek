// Decides what to do with the copy on this phone and the copy in the cloud, and does it without
// losing an entry. Knows nothing about Firebase.
import { createBackup, serializeBackup, validateLedger } from "../core/backup.ts";
import { isoWeekKey, todayIn } from "../core/dates.ts";
import { loadLedger, readAll } from "../core/restore.ts";
import type { Store, Tx } from "../core/store.ts";
import { DATA_STORES, type CloudLink, type CloudMeta, type LedgerData, type MetaRecord, type SnapshotRecord } from "../core/types.ts";
import { cloudView, fingerprint, isBlank, pack, unpack, type Packed } from "./bundle.ts";
import { peopleIn, threeWay, type Merged } from "./merge.ts";
import { CloudError, MAX_BYTES, PART_BYTES, type CloudPort, type Head, type Version } from "./port.ts";

export type Choice = "combine" | "keep_phone" | "keep_cloud";
export type Reason = "both_changed" | "first_link" | "cloud_replaced" | "cloud_deleted" | "cloud_unreadable";
/** The situation a person chose in. A choice is not applied to another one. */
export type About = { reason: Reason; versionId: string | null };
export type SyncState =
  | { kind: "up_to_date" | "saved" | "pulled" | "combined"; link: CloudLink; people: number }
  /** Nothing on this phone and nothing in the cloud. */
  | { kind: "empty" }
  /** Something was entered while working; try again. */
  | { kind: "again" }
  | { kind: "choose"; reason: Reason; head: Head | null; canCombine: boolean; people: string[] }
  /** This phone's notebook belongs to another account. Nothing was sent or received. */
  | { kind: "foreign"; email: string };

export type SyncOpts = {
  uid: string;
  email: string;
  device: string;
  appVersion?: string;
  now?: () => Date;
  choice?: Choice;
  about?: About;
  newId?: () => string;
  /** Called when the notebooks on this phone were changed, even if a later step then fails. */
  onApplied?: () => void;
};

const BASE = "cloud_base";
const PENDING = "cloud_pending";
const AUTO_SNAPSHOTS = 3;
const PHOTOS_GO = "cloud: before photos go";

// ---------------------------------------------------------------- which versions are kept

const NEWEST = 3;
const DAYS = 7;
const WEEKS = 4;
const MONTHS = 6;

/** Versions to remove once `currentId` is the current one. */
export function versionsToDrop(versions: Version[], currentId: string): Version[] {
  const list = [...versions].sort((a, b) => b.rev - a.rev);
  const keep = new Set([currentId, ...list.filter((v) => v.pinned).map((v) => v.id), ...list.slice(0, NEWEST).map((v) => v.id)]);
  const lastOf = (key: (v: Version) => string, limit: number) => {
    const seen = new Set<string>();
    for (const v of list) {
      const k = key(v);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(v.id);
    }
  };
  const day = (v: Version) => todayIn(undefined, new Date(v.at));
  lastOf(day, DAYS);
  lastOf((v) => isoWeekKey(day(v)), WEEKS);
  lastOf((v) => day(v).slice(0, 7), MONTHS);
  return list.filter((v) => !keep.has(v.id));
}

// ---------------------------------------------------------------- this phone's side

type Local = { data: LedgerData; print: string; meta: MetaRecord; base: LedgerData | null; cloud: CloudMeta | null };

async function readLocal(store: Store): Promise<Local & { baseRow?: SnapshotRecord; pendingRow?: SnapshotRecord }> {
  const r = await store.run("readonly", async (tx) => ({
    data: await readAll(tx),
    meta: (await tx.get("meta", "app")) as MetaRecord,
    baseRow: await tx.get("snapshots", BASE),
    pendingRow: await tx.get("snapshots", PENDING),
  }));
  return { ...r, print: fingerprint(r.data), base: null, cloud: r.meta?.cloud ?? null };
}

async function openRow(row: SnapshotRecord | undefined, versionId: string | undefined): Promise<LedgerData | null> {
  if (!row?.bytes || !versionId || row.reason !== versionId) return null;
  try {
    return (await unpack(row.bytes, row.encoding ?? "gzip")).data;
  } catch {
    return null; // without a common copy the comparison is stricter, never looser
  }
}

const baseRow = (id: string, p: Pick<Packed, "bytes" | "encoding">, versionId: string, at: string): SnapshotRecord => ({ id, createdAt: at, reason: versionId, backup: "", bytes: p.bytes, encoding: p.encoding });

async function setCloud(tx: Tx, patch: Partial<CloudMeta> & { uid: string; email: string }) {
  const meta = (await tx.get("meta", "app")) as MetaRecord;
  const cloud: CloudMeta = { ...(meta.cloud?.uid === patch.uid ? meta.cloud : {}), ...patch };
  if (cloud.link || cloud.pendingId) cloud.bound = true;
  await tx.put("meta", { ...meta, cloud });
}

/** The notebooks are still those the round read: same account, not replaced by a file meanwhile. */
async function sameNotebooks(tx: Tx, uid: string, epoch: string | undefined): Promise<boolean> {
  const cloud = ((await tx.get("meta", "app")) as MetaRecord).cloud;
  return cloud?.uid === uid && cloud.epoch === epoch;
}

/**
 * Puts another state of the real notebooks on this phone, in one transaction. Returns false,
 * changing nothing, when an entry was made since `print` was read. Photos and the demo notebook
 * stay. With a `reason`, the present state is kept on the phone as a snapshot; without one it is
 * already a copy in the cloud (or empty), and a snapshot is made only when photos would go with
 * their notebook, since the cloud has none.
 */
async function applyState(store: Store, o: SyncOpts, print: string, next: LedgerData, now: Date, reason: string | null, extra: (tx: Tx) => Promise<void>): Promise<boolean> {
  const view = cloudView(next);
  const present = await loadLedger(store);
  const stays = new Set([...view.workspaces.map((w) => w.id), ...present.workspaces.filter((w) => w.demo).map((w) => w.id)]);
  if (!reason && present.attachments.some((a) => !stays.has(a.workspaceId))) reason = PHOTOS_GO;
  const before = reason && serializeBackup(await createBackup(present, { now }));
  const done = await store.run("readwrite", async (tx) => {
    const current = await readAll(tx);
    if (fingerprint(current) !== print) return false;
    if (reason && before) {
      const id = `snap_${now.getTime()}`;
      await tx.put("snapshots", { id, createdAt: now.toISOString(), reason, backup: before });
      // The new one stays even under a clock that was set back; those with photos are counted apart.
      const others = (await tx.all("snapshots")).filter((s) => s.reason.startsWith("cloud: ") && (s.reason === PHOTOS_GO) === (reason === PHOTOS_GO) && s.id !== id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const s of others.slice(AUTO_SNAPSHOTS - 1)) await tx.delete("snapshots", s.id);
    }
    const real = new Set(current.workspaces.filter((w) => !w.demo).map((w) => w.id));
    for (const s of DATA_STORES) {
      if (s === "attachments") continue;
      const ids = new Set((view[s] as { id: string }[]).map((r) => r.id));
      for (const r of current[s] as { id: string; workspaceId?: string }[]) if (real.has(s === "workspaces" ? r.id : r.workspaceId!) && !ids.has(r.id)) await tx.delete(s, r.id);
      for (const r of view[s] as never[]) await tx.put(s, r);
    }
    const kept = new Set(view.workspaces.map((w) => w.id));
    for (const a of current.attachments) if (real.has(a.workspaceId) && !kept.has(a.workspaceId)) await tx.delete("attachments", a.id);
    await extra(tx);
    const meta = (await tx.get("meta", "app")) as MetaRecord;
    const active = (await tx.all("workspaces")).filter((w) => !w.archivedAt);
    // Somebody looking at the demo stays there, unless the first real notebook has just arrived.
    const open = active.find((w) => w.id === meta.activeWorkspaceId);
    if (!open || (open.demo && !real.size)) {
      const first = active.find((w) => !w.demo) ?? active.find((w) => w.id === meta.activeWorkspaceId);
      await tx.put("meta", { ...meta, activeWorkspaceId: first?.id ?? null });
    }
    return true;
  });
  if (done) o.onApplied?.();
  return done;
}

// ---------------------------------------------------------------- one round

export async function syncOnce(store: Store, port: CloudPort, o: SyncOpts): Promise<SyncState> {
  const seen: { head: Head | null } = { head: null };
  try {
    return await round(store, port, o, seen);
  } catch (e) {
    // A copy that vanished because another phone has saved since is not a damaged one.
    if (codeOf(e) === "cloud_corrupt" && seen.head && moved(seen.head, await port.head())) return { kind: "again" };
    throw e;
  }
}

const codeOf = (e: unknown) => (e as { code?: string })?.code;
const moved = (then: Head, now: Head | null) => now?.rev !== then.rev || now.lineage !== then.lineage;

async function round(store: Store, port: CloudPort, o: SyncOpts, seen: { head: Head | null }): Promise<SyncState> {
  const now = o.now ?? (() => new Date());
  const newId = o.newId ?? (() => crypto.randomUUID());
  const started = now();
  const local = await readLocal(store);
  const view = cloudView(local.data);
  const blank = isBlank(view);
  // Also an empty notebook: it may carry the first person's shop name and numbers.
  if (local.cloud?.bound && local.cloud.uid !== o.uid && view.workspaces.length) return { kind: "foreign", email: local.cloud.email };
  // A phone without a notebook may open any account. From here on this phone knows it has one, also when there
  // is nothing to save yet or a choice is waiting: the next start must not forget it.
  if (local.cloud?.uid !== o.uid) await store.run("readwrite", (tx) => setCloud(tx, { uid: o.uid, email: o.email }));
  let link = local.cloud?.uid === o.uid ? (local.cloud.link ?? null) : null;
  const pendingId = local.cloud?.uid === o.uid ? local.cloud.pendingId : undefined;
  let baseSource = local.baseRow;
  const head = await port.head();
  seen.head = head;

  // A save whose answer was lost: the cloud has it, so it is the last common copy.
  const arrived = pendingId && link?.versionId !== pendingId ? head?.versions.find((v) => v.id === pendingId) : undefined;
  const epoch = local.cloud?.uid === o.uid ? local.cloud.epoch : undefined;
  if (head && arrived) {
    link = linkOf({ lineage: head.lineage, rev: arrived.rev }, arrived, new Date(arrived.at));
    baseSource = local.pendingRow;
    const row = local.pendingRow;
    const done = await store.run("readwrite", async (tx) => {
      if (!(await sameNotebooks(tx, o.uid, epoch))) return false;
      await setCloud(tx, { uid: o.uid, email: o.email, link: link!, pendingId: undefined });
      if (row) await tx.put("snapshots", { ...row, id: BASE });
      await tx.delete("snapshots", PENDING);
      return true;
    });
    if (!done) return { kind: "again" };
  }

  const packed = await pack(local.data, { now: now(), appVersion: o.appVersion });
  const ctx: Ctx = { store, port, o, now, newId, local, epoch, view, packed, started };
  const choice = (reason: Reason, versionId: string | null) => (o.about?.reason === reason && o.about.versionId === versionId ? o.choice : undefined);

  if (!head) {
    if (link) {
      if (choice("cloud_deleted", null) === "keep_phone") return push(ctx, null, { lineage: newId() });
      return { kind: "choose", reason: "cloud_deleted", head: null, canCombine: false, people: [] };
    }
    if (!view.workspaces.length) return { kind: "empty" };
    return push(ctx, null, { lineage: newId() });
  }

  const current = currentOf(head);
  if (current.sha === packed.sha) {
    if (link && link.versionId === current.id && link.rev === head.rev && link.lineage === head.lineage) return { kind: "up_to_date", link, people: packed.people };
    return adopt(ctx, head, current);
  }
  if (current.schemaVersion > packed.schemaVersion) throw new CloudError("cloud_update_app");

  // The same cloud copy, at the point where this phone left it or further. One that went back in
  // time is not: nothing is decided alone about it.
  const related = !!link && link.lineage === head.lineage && link.rev <= head.rev;
  // Entries are never deleted, so an empty phone has lost its notebook: it must not be sent.
  const lost = blank && (current.people > 0 || current.entries > 0 || !related || !view.workspaces.length);
  if (related && link!.rev === head.rev && !lost) return push(ctx, head);

  let remote: LedgerData;
  try {
    remote = await fetchVersion(port, current);
  } catch (e) {
    // An empty phone has nothing to offer instead: the person may put an older copy back.
    if (codeOf(e) !== "cloud_corrupt" || lost || moved(head, await port.head())) throw e;
    if (choice("cloud_unreadable", current.id) === "keep_phone") return push(ctx, head, { pin: current.id });
    return { kind: "choose", reason: "cloud_unreadable", head, canCombine: false, people: [] };
  }
  if (lost || (related && link!.sha === packed.sha)) return pull(ctx, head, current, remote);

  // Both sides have something the other does not.
  const base = related ? await openRow(baseSource, link!.versionId) : null;
  const merged = threeWay(base, view, remote);
  const clean = merged.conflicts.length === 0;
  const reason = related ? "both_changed" : link ? "cloud_replaced" : "first_link";
  const picked = choice(reason, current.id);
  const sure = clean && !merged.doubts.length;
  if (clean && (picked === "combine" || (sure && related && !picked))) return combine(ctx, head, merged);
  if (picked === "keep_phone") return push(ctx, head, { pin: current.id });
  if (picked === "keep_cloud") return keepCloud(ctx, head, current, remote);
  return { kind: "choose", reason, head, canCombine: clean, people: peopleIn([...merged.conflicts, ...merged.doubts], view, remote) };
}

type Ctx = { store: Store; port: CloudPort; o: SyncOpts; now: () => Date; newId: () => string; local: Local; epoch: string | undefined; view: LedgerData; packed: Packed; started: Date };

function currentOf(head: Head): Version {
  const v = head.versions.find((x) => x.id === head.versionId);
  if (!v) throw new CloudError("cloud_corrupt");
  return v;
}

const linkOf = (head: Pick<Head, "lineage" | "rev">, v: Version, at: Date): CloudLink => ({ lineage: head.lineage, rev: head.rev, versionId: v.id, sha: v.sha, savedAt: at.toISOString() });

async function fetchVersion(port: CloudPort, v: Version): Promise<LedgerData> {
  const bytes = await port.read(v);
  try {
    const { data, sha } = await unpack(bytes, v.encoding);
    if (sha === v.sha) return data;
  } catch (e) {
    if (["newer_schema", "cloud_update_app"].includes(codeOf(e) ?? "")) throw e;
  }
  throw new CloudError("cloud_corrupt");
}

function makeVersion(ctx: Ctx, packed: Packed, head: Head | null): Version {
  if (packed.bytes.length > MAX_BYTES) throw new CloudError("cloud_too_big");
  const at = ctx.started.toISOString();
  return {
    id: ctx.newId(),
    rev: (head?.rev ?? 0) + 1,
    at: head && head.updatedAt > at ? head.updatedAt : at, // a late phone clock must not age it
    device: ctx.o.device,
    bytes: packed.bytes.length,
    parts: Math.max(1, Math.ceil(packed.bytes.length / PART_BYTES)),
    encoding: packed.encoding,
    sha: packed.sha,
    schemaVersion: packed.schemaVersion,
    people: packed.people,
    entries: packed.entries,
  };
}

/** The list after one more save. The server's time replaces the phone's guess on the previous newest. */
function nextVersions(head: Head | null, add: Version, currentId: string, pin: string[]) {
  const newest = head ? Math.max(...head.versions.map((v) => v.rev)) : 0;
  const list = (head?.versions ?? []).map((v) => ({ ...v, at: v.rev === newest ? head!.updatedAt : v.at, ...(pin.includes(v.id) ? { pinned: true } : {}) }));
  const all = [...list, pin.includes(add.id) ? { ...add, pinned: true } : add];
  // At most ten pinned copies; the oldest lose the pin.
  for (const v of all.filter((x) => x.pinned).sort((a, b) => b.rev - a.rev).slice(10)) delete v.pinned;
  const drop = versionsToDrop(all, currentId);
  const gone = new Set(drop.map((v) => v.id));
  return { versions: all.filter((v) => !gone.has(v.id)), drop };
}

async function push(ctx: Ctx, head: Head | null, how: { lineage?: string; pin?: string } = {}): Promise<SyncState> {
  const { store, port, o, packed } = ctx;
  // No copy becomes the current one that no phone could open.
  if (validateLedger(ctx.view).length) throw new CloudError("cloud_invalid");
  const v = makeVersion(ctx, packed, head);
  const pins = [how.pin, ctx.local.cloud?.uid === o.uid ? ctx.local.cloud.pin : undefined].filter((x) => x !== undefined);
  const { versions, drop } = nextVersions(head, v, v.id, pins);
  const next = { lineage: head?.lineage ?? how.lineage!, rev: v.rev, versionId: v.id, versions };
  // Written down before sending, so a lost answer is recognised afterwards.
  const still = await store.run("readwrite", async (tx) => {
    if (!(await sameNotebooks(tx, o.uid, ctx.epoch))) return false;
    await setCloud(tx, { uid: o.uid, email: o.email, pendingId: v.id });
    await tx.put("snapshots", baseRow(PENDING, packed, v.id, v.at));
    return true;
  });
  if (!still) return { kind: "again" };
  await port.save({ after: head && { lineage: head.lineage, rev: head.rev }, head: next, add: { version: v, bytes: packed.bytes }, drop });
  const link = linkOf(next, v, ctx.started);
  return (await remember(ctx, link, packed, { pin: undefined })) ? { kind: "saved", link, people: packed.people } : { kind: "again" };
}

/** False, and nothing written, when a person replaced the notebooks while the round was on its way. */
async function remember(ctx: Ctx, link: CloudLink, packed: Pick<Packed, "bytes" | "encoding">, more: Partial<CloudMeta> = {}): Promise<boolean> {
  return ctx.store.run("readwrite", async (tx) => {
    if (!(await sameNotebooks(tx, ctx.o.uid, ctx.epoch))) return false;
    await rememberIn(tx, ctx, link, packed, more);
    return true;
  });
}

async function rememberIn(tx: Tx, ctx: Ctx, link: CloudLink, packed: Pick<Packed, "bytes" | "encoding">, more: Partial<CloudMeta> = {}) {
  await setCloud(tx, { uid: ctx.o.uid, email: ctx.o.email, link, pendingId: undefined, ...more });
  await tx.put("snapshots", baseRow(BASE, packed, link.versionId, link.savedAt));
  await tx.delete("snapshots", PENDING);
}

async function adopt(ctx: Ctx, head: Head, v: Version): Promise<SyncState> {
  const link = linkOf(head, v, ctx.started);
  return (await remember(ctx, link, ctx.packed)) ? { kind: "up_to_date", link, people: ctx.packed.people } : { kind: "again" };
}

async function pull(ctx: Ctx, head: Head, v: Version, remote: LedgerData): Promise<SyncState> {
  const packed = await pack(remote, { now: ctx.now(), appVersion: ctx.o.appVersion });
  const link = linkOf(head, v, ctx.started);
  const done = await applyState(ctx.store, ctx.o, ctx.local.print, remote, ctx.now(), null, (tx) => rememberIn(tx, ctx, link, packed));
  return done ? { kind: "pulled", link, people: packed.people } : { kind: "again" };
}

async function combine(ctx: Ctx, head: Head, merged: Merged): Promise<SyncState> {
  const packed = await pack(merged.data, { now: ctx.now(), appVersion: ctx.o.appVersion });
  // First on the phone, where it is checked against entries made meanwhile; then in the cloud. If
  // sending fails, the phone simply has something newer than the cloud.
  const cur = currentOf(head);
  const link = { ...linkOf(head, cur, ctx.started), savedAt: ctx.local.cloud?.link?.savedAt ?? cur.at };
  const basePacked = await pack(await fetchVersion(ctx.port, cur), { now: ctx.now(), appVersion: ctx.o.appVersion });
  const done = await applyState(ctx.store, ctx.o, ctx.local.print, merged.data, ctx.now(), "cloud: before combining", (tx) => rememberIn(tx, ctx, link, basePacked));
  if (!done) return { kind: "again" };
  const s = await push({ ...ctx, packed, view: cloudView(merged.data) }, head);
  return s.kind === "saved" ? { ...s, kind: "combined" } : s;
}

async function keepCloud(ctx: Ctx, head: Head, current: Version, remote: LedgerData): Promise<SyncState> {
  // This phone's copy is kept in the cloud first, beside the current one.
  const mine = makeVersion(ctx, ctx.packed, head);
  const { versions, drop } = nextVersions(head, mine, current.id, [mine.id]);
  const next = { lineage: head.lineage, rev: mine.rev, versionId: current.id, versions };
  await ctx.port.save({ after: { lineage: head.lineage, rev: head.rev }, head: next, add: { version: mine, bytes: ctx.packed.bytes }, drop });
  const packed = await pack(remote, { now: ctx.now(), appVersion: ctx.o.appVersion });
  const link = linkOf(next, current, ctx.started);
  const done = await applyState(ctx.store, ctx.o, ctx.local.print, remote, ctx.now(), "cloud: before taking the cloud copy", (tx) => rememberIn(tx, ctx, link, packed));
  return done ? { kind: "pulled", link, people: packed.people } : { kind: "again" };
}

// ---------------------------------------------------------------- what a person asks for

/** Puts an older cloud copy on this phone. The present state is in the cloud first, or nothing happens. */
export async function restoreVersion(store: Store, port: CloudPort, o: SyncOpts, versionId: string): Promise<SyncState> {
  // Read first: saving the present state may push out the very copy that is asked for.
  const head = await port.head();
  const v = head?.versions.find((x) => x.id === versionId);
  if (!head || !v) throw new CloudError("cloud_version_gone");
  const old = await fetchVersion(port, v);
  let next = o;
  try {
    const s = await syncOnce(store, port, o);
    if (!SAFE.has(s.kind)) return s;
  } catch (e) {
    if (codeOf(e) === "cloud_corrupt" && isBlank(cloudView(await loadLedger(store)))) {
      // The current copy cannot be opened and this phone is empty: the older one takes its place.
      next = { ...o, choice: "keep_phone", about: { reason: "cloud_unreadable", versionId: head.versionId } };
    } else if (codeOf(e) !== "cloud_invalid") throw e; // an inconsistent notebook is kept on the phone, below
  }
  const now = o.now ?? (() => new Date());
  const local = await readLocal(store);
  // The link stays on the current copy, so the older state is sent as a new change after it. The
  // current copy is kept whatever its age, written down here so that a failed sending keeps it too.
  const done = await applyState(store, o, local.print, old, now(), "cloud: before an older copy", async (tx) => {
    if (local.cloud?.uid === o.uid && local.cloud.link) await setCloud(tx, { uid: o.uid, email: o.email, pin: local.cloud.link.versionId });
  });
  if (!done) return { kind: "again" };
  return syncOnce(store, port, next);
}

/** Rounds after which the cloud has all of this phone (photos aside). */
const SAFE = new Set<SyncState["kind"]>(["up_to_date", "saved", "combined", "pulled"]);

/** This phone's state if the account had all of it (photos aside) at the last save, else null. */
async function savedPrint(store: Store, uid: string): Promise<string | null> {
  const local = await readLocal(store);
  if (isBlank(cloudView(local.data))) return local.print;
  if (local.cloud?.uid !== uid || !local.cloud.link) return null;
  return (await pack(local.data, { now: new Date() })).sha === local.cloud.link.sha ? local.print : null;
}

export const everythingSaved = async (store: Store, uid: string): Promise<boolean> => (await savedPrint(store, uid)) !== null;

/** Wipes the phone if the cloud has, now, everything on it. False: nothing was done. */
export async function removeSaved(store: Store, port: CloudPort, o: SyncOpts): Promise<boolean> {
  const s = await syncOnce(store, port, o);
  if (!SAFE.has(s.kind) && s.kind !== "empty") return false;
  const print = await savedPrint(store, o.uid);
  return print !== null && wipePhone(store, print);
}

/** Wipes another account's notebook, as far as this phone knows saved. The cloud cannot be asked: it is not ours. */
export async function removeForeign(store: Store): Promise<boolean> {
  const meta = await store.run("readonly", (tx) => tx.get("meta", "app"));
  const print = await savedPrint(store, meta?.cloud?.uid ?? "");
  return print !== null && wipePhone(store, print, false);
}

/**
 * The notebook on this phone goes to the account signed in now, at the person's own wish (their
 * first account is lost, say). The link with the other account is dropped, so nothing in this one
 * is replaced without asking.
 */
export async function claimPhone(store: Store, who: { uid: string; email: string }): Promise<void> {
  await store.run("readwrite", async (tx) => {
    const meta = (await tx.get("meta", "app")) as MetaRecord;
    await tx.put("meta", { ...meta, cloud: { uid: who.uid, email: who.email, bound: true } });
    await tx.delete("snapshots", BASE);
    await tx.delete("snapshots", PENDING);
  });
}

/**
 * Removes every notebook, photo, key and note about the account from this phone. With `print`, only
 * if nothing was entered since it was read; false when something was. `stop`: the account leaves
 * this phone, so rounds that other tabs have begun with it must not go on.
 */
export async function wipePhone(store: Store, print?: string, stop = true): Promise<boolean> {
  return store.run("readwrite", async (tx) => {
    if (print !== undefined && fingerprint(await readAll(tx)) !== print) return false;
    for (const s of DATA_STORES) await tx.clear(s);
    await tx.clear("commands");
    await tx.clear("snapshots");
    const meta = (await tx.get("meta", "app")) as MetaRecord;
    await tx.put("meta", { id: "app", schemaVersion: meta.schemaVersion, deviceId: meta.deviceId, activeWorkspaceId: null, lastBackupAt: null, persistentStorage: meta.persistentStorage, cloudStop: stop ? crypto.randomUUID() : meta.cloudStop });
    return true;
  });
}

/** This account is gone by the person's own wish. A notebook of another account keeps its mark. */
export async function forgetAccount(store: Store, uid: string): Promise<void> {
  await store.run("readwrite", async (tx) => {
    const meta = (await tx.get("meta", "app")) as MetaRecord;
    if (meta.cloud?.uid !== uid) return;
    await tx.put("meta", { ...meta, cloud: null, cloudStop: crypto.randomUUID() });
    await tx.delete("snapshots", BASE);
    await tx.delete("snapshots", PENDING);
  });
}

// The second copy in the person's own Google Drive: what is sent, what is kept, what is refused,
// and that it comes back whole on another phone through the same checked restore.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../lib/core/store.ts";
import { canonical, computeTotals } from "../lib/core/backup.ts";
import { loadLedger, restoreBackup } from "../lib/core/restore.ts";
import { copiesToDrop, listCopies, readCopy, saveCopy, signature, type CopyInfo } from "../lib/drive/copy.ts";
import { FakeDrive } from "../lib/drive/fake.ts";
import { HttpDrive, SIMPLE_MAX } from "../lib/drive/http.ts";
import { DriveError } from "../lib/drive/port.ts";
import { basic, DA, harness, NOW } from "./helpers.ts";

const PHONE = "phone-aaaaaaaa-1111";
const OTHER = "phone-bbbbbbbb-2222";
const PHOTO = Buffer.from("a photo of a receipt").toString("base64");
const HOUR = 3_600_000;

async function shop() {
  const h = await basic();
  const { obligationId } = await h.run("createObligation", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(10_000), date: "2026-11-01" });
  await h.run("recordPayment", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(2_500), date: "2026-11-05" });
  await h.run("addAttachment", { workspaceId: h.workspaceId, ownerType: "obligation", ownerId: obligationId, name: "recu.jpg", mime: "image/jpeg", data: PHOTO, sha256: "0".repeat(64) });
  return h;
}

const at = (iso: string | number, device = PHONE) => ({ now: new Date(iso), device, deviceName: "Android" });

test("drive: a copy, photos included, comes back whole on a new phone (0 DA difference)", async () => {
  const h = await shop();
  const drive = new FakeDrive();
  const r = await saveCopy(drive, h.store, at("2026-11-22T10:00:00Z"));
  assert.equal(r.kind, "saved");
  const [copy] = await listCopies(drive);
  assert.deepEqual([copy.people, copy.entries, copy.photos, copy.device, copy.deviceName], [1, 2, 1, PHONE, "Android"]);
  const file = await readCopy(drive, copy);
  const fresh = new MemoryStore();
  await restoreBackup(fresh, file, { mode: "replace" });
  const before = await loadLedger(h.store);
  const after = await loadLedger(fresh);
  assert.equal(canonical(computeTotals(after, NOW)), canonical(computeTotals(before, NOW)));
  assert.equal(after.attachments[0].data, PHOTO);
});

test("drive: an empty phone, or one with only the demo notebook, sends nothing", async () => {
  const drive = new FakeDrive();
  const empty = harness();
  await empty.run("createWorkspace", { name: "Mon carnet" });
  assert.equal((await saveCopy(drive, empty.store, at("2026-11-22T10:00:00Z"))).kind, "empty");
  const demo = harness();
  const { workspaceId } = await demo.run("createWorkspace", { name: "Démo", demo: true });
  await demo.run("createParty", { workspaceId, displayName: "Exemple" });
  assert.equal((await saveCopy(drive, demo.store, at("2026-11-22T10:00:00Z"))).kind, "empty");
  assert.deepEqual(drive.calls, []);
});

test("drive: the demo notebook never goes with a real one", async () => {
  const h = await shop();
  const { workspaceId } = await h.run("createWorkspace", { name: "Démo", demo: true });
  await h.run("createParty", { workspaceId, displayName: "Exemple" });
  const drive = new FakeDrive();
  await saveCopy(drive, h.store, at("2026-11-22T10:00:00Z"));
  const file = await readCopy(drive, (await listCopies(drive))[0]);
  assert.deepEqual(file.scope.workspaceIds, [h.workspaceId]);
});

test("drive: old copies thin out by age, and another phone's copies are never removed", async () => {
  const h = await shop();
  const other = await shop();
  const drive = new FakeDrive();
  await saveCopy(drive, other.store, at("2026-09-01T08:00:00Z", OTHER));
  const start = Date.parse("2026-09-01T08:00:00Z");
  for (let d = 0; d < 60; d++) for (const hour of [0, 3, 6, 9]) await saveCopy(drive, h.store, at(start + d * 24 * HOUR + hour * HOUR));
  const all = await listCopies(drive);
  const mine = all.filter((c) => c.device === PHONE);
  assert.ok(mine.length <= 3 + 7 + 4 + 6 && mine.length >= 10, `${mine.length} copies kept`);
  assert.equal(mine[0].at, new Date(start + 59 * 24 * HOUR + 9 * HOUR).toISOString(), "the newest stays");
  assert.ok(mine.some((c) => c.at.startsWith("2026-09")), "one from each recent month stays");
  assert.equal(all.filter((c) => c.device === OTHER).length, 1);
});

test("drive: a copy holding a notebook or more than the newer ones is kept whatever its age", async () => {
  const drive = new FakeDrive();
  const big = await shop();
  for (let i = 0; i < 3; i++) await saveCopy(drive, big.store, at(Date.parse("2026-11-01T10:00:00Z") + i * HOUR));
  // The same phone now holds another, smaller notebook (a file put in its place, another account's copy).
  const small = await basic();
  for (let i = 0; i < 60; i++) await saveCopy(drive, small.store, at(Date.parse("2026-11-02T10:00:00Z") + i * 30 * HOUR));
  const kept = (await listCopies(drive)).filter((c) => c.entries === 2);
  assert.ok(kept.length >= 1, "a copy with the old notebook is still there");
  assert.equal((await readCopy(drive, kept[0])).manifest.counts.obligations, 1);
});

test("drive: photos that left the phone stay in a copy (no label that a failed request could lose)", async () => {
  const drive = new FakeDrive();
  const h = await shop();
  const start = Date.parse("2026-11-20T08:00:00Z");
  for (let i = 0; i < 3; i++) await saveCopy(drive, h.store, at(start + i * HOUR));
  // The photo is gone from the phone (removed, or the phone wiped and the account's copy taken back).
  await h.store.run("readwrite", async (tx) => tx.clear("attachments"));
  const failing = drive.remove.bind(drive);
  let n = 0;
  drive.remove = async (id) => {
    if (n++ === 0) throw new DriveError("drive_offline");
    return failing(id);
  };
  for (let i = 3; i < 40; i++) await saveCopy(drive, h.store, at(start + i * 20 * 60_000));
  const withPhoto = (await listCopies(drive)).filter((c) => c.photos === 1);
  assert.ok(withPhoto.length >= 1, "a copy with the photo is still there");
  assert.equal((await readCopy(drive, withPhoto[0])).manifest.counts.attachments, 1);
});

test("drive: after many merges of people, the copy with the most is still there", () => {
  const list: CopyInfo[] = [];
  const base = Date.parse("2026-01-01T10:00:00Z");
  // A copy a day for 300 days; the records grow, but 40 times something leaves (a photo removed).
  for (let d = 0; d < 300; d++) list.push({ id: `c${d}`, at: new Date(base + d * 24 * HOUR).toISOString(), device: PHONE, deviceName: "", bytes: 1, encoding: "gzip", sha: "x", people: 200 - Math.floor(d / 7), entries: 10, photos: d % 7 === 0 ? 1 : 0, records: 1000 + d, books: ["a"], audit: 0, last: "", holds: "" });
  list[5].records = 5000; // an old copy that held far more than anything since
  const newest = list.at(-1)!;
  const drop = new Set(copiesToDrop(list, newest.id).map((c) => c.id));
  assert.ok(!drop.has("c5"), "the copy holding the most is kept");
  assert.ok(!drop.has(newest.id));
  const kept = list.filter((c) => !drop.has(c.id));
  assert.ok(kept.length <= 3 + 7 + 4 + 6 + 20 + 3, `${kept.length} kept`);
});

test("drive: a notebook copied once keeps a copy, whatever came after", () => {
  const list: CopyInfo[] = [];
  const base = Date.parse("2025-01-01T10:00:00Z");
  for (let d = 0; d < 400; d++) list.push({ id: `c${d}`, at: new Date(base + d * 24 * HOUR).toISOString(), device: PHONE, deviceName: "", bytes: 1, encoding: "gzip", sha: "x", people: 1, entries: 1, photos: 0, records: 10 + d, books: d === 0 ? ["old"] : ["new"], audit: 0, last: "", holds: "" });
  const drop = new Set(copiesToDrop(list, list.at(-1)!.id).map((c) => c.id));
  assert.ok(!drop.has("c0"), "the only copy of the old notebook stays");
});

test("drive: what a restore or the account brings counts as not copied yet", async () => {
  const h = await shop();
  const drive = new FakeDrive();
  const r = await saveCopy(drive, h.store, at("2026-11-22T10:00:00Z"));
  assert.equal(r.kind, "saved");
  const copied = r.kind === "saved" ? r.signature : "";
  assert.equal(signature(await loadLedger(h.store)), copied);
  // A notebook with older entries arrives (merge restore): no new audit time, still a change.
  const other = await shop();
  const d2 = new FakeDrive();
  await saveCopy(d2, other.store, at("2026-11-01T10:00:00Z"));
  await restoreBackup(h.store, await readCopy(d2, (await listCopies(d2))[0]), { mode: "merge" });
  assert.notEqual(signature(await loadLedger(h.store)), copied);
});

test("drive: Google storage full: the error says so and no old copy is touched", async () => {
  const h = await shop();
  const drive = new FakeDrive();
  await saveCopy(drive, h.store, at("2026-11-01T10:00:00Z"));
  const before = await listCopies(drive);
  drive.full = true;
  for (let i = 1; i < 30; i++) await assert.rejects(saveCopy(drive, h.store, at(Date.parse("2026-11-01T10:00:00Z") + i * 24 * HOUR)), (e: DriveError) => e.code === "drive_full");
  assert.deepEqual(await listCopies(drive), before);
});

test("drive: a copy that arrived different is removed, and the older ones stay", async () => {
  const h = await shop();
  const drive = new FakeDrive();
  await saveCopy(drive, h.store, at("2026-11-01T10:00:00Z"));
  const before = await listCopies(drive);
  const upload = drive.upload.bind(drive);
  drive.upload = async (name, bytes, props) => upload(name, bytes.slice(0, bytes.length - 1), props);
  await assert.rejects(saveCopy(drive, h.store, at("2026-11-02T10:00:00Z")), (e: DriveError) => e.code === "drive_failed");
  assert.deepEqual(await listCopies(drive), before);
});

test("drive: a damaged copy is refused before anything is restored", async () => {
  const h = await shop();
  const drive = new FakeDrive();
  await saveCopy(drive, h.store, at("2026-11-01T10:00:00Z"));
  const [copy] = await listCopies(drive);
  drive.spoil(copy.id);
  await assert.rejects(readCopy(drive, copy), (e: DriveError) => e.code === "drive_damaged");
});

test("drive: a notebook that breaks a ledger rule is not sent (no copy that cannot be put back)", async () => {
  const h = await shop();
  const id = (await loadLedger(h.store)).obligations[0].id;
  await h.store.run("readwrite", async (tx) =>
    tx.put("adjustments", { id: "adj_bad", workspaceId: h.workspaceId, partyId: h.partyId, obligationId: id, type: "decrease", amount: DA(50_000), date: "2026-11-02", reason: "x", createdAt: "2026-11-02T00:00:00Z", createdBy: "x" } as never),
  );
  const drive = new FakeDrive();
  await assert.rejects(saveCopy(drive, h.store, at("2026-11-02T10:00:00Z")), (e: DriveError) => e.code === "drive_invalid");
  assert.equal(drive.calls.includes("upload"), false);
});

test("drive: a copy that cannot be removed now goes at a later save; other files are left alone", async () => {
  const h = await shop();
  const drive = new FakeDrive();
  await drive.upload("notes.txt", new Uint8Array([1, 2, 3]), { other: "app" });
  const start = Date.parse("2026-11-01T10:00:00Z");
  const remove = drive.remove.bind(drive);
  drive.remove = async () => {
    throw new DriveError("drive_busy");
  };
  for (let i = 0; i < 6; i++) assert.equal((await saveCopy(drive, h.store, at(start + i * HOUR))).kind, "saved");
  assert.equal((await listCopies(drive)).length, 6);
  drive.remove = remove;
  await saveCopy(drive, h.store, at(start + 6 * HOUR));
  assert.ok((await listCopies(drive)).length < 7);
  assert.ok((await drive.list()).some((f) => f.name === "notes.txt"));
});

test("drive: a notebook that only grows keeps the newest three, one a day, a week and a month", () => {
  const list: CopyInfo[] = [];
  for (let d = 0; d < 400; d++) list.push({ id: `c${d}`, at: new Date(Date.parse("2025-10-01T12:00:00Z") + d * 24 * HOUR).toISOString(), device: PHONE, deviceName: "", bytes: 1, encoding: "gzip", sha: "x", people: 1, entries: 1, photos: 0, records: d, books: ["a"], audit: 0, last: "", holds: "" });
  const newest = list.at(-1)!;
  const drop = new Set(copiesToDrop(list, newest.id).map((c) => c.id));
  const kept = list.filter((c) => !drop.has(c.id));
  assert.ok(!drop.has(newest.id));
  assert.ok(kept.length <= 3 + 7 + 4 + 6, `${kept.length} kept`);
});

// ---------------------------------------------------------------- Google's side

type Call = { url: string; init?: RequestInit };
function google(answers: ((c: Call) => Response)[]) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    const a = answers.shift();
    if (!a) throw new TypeError("Failed to fetch");
    return a(c);
  };
  return { calls, fetcher };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const fail = (status: number, reason?: string) => () => json({ error: { code: status, errors: reason ? [{ reason }] : [] } }, status);

test("google: only the hidden folder is listed, page after page, with the token", async () => {
  const g = google([() => json({ nextPageToken: "p2", files: [{ id: "a", name: "x", createdTime: "t", size: "12", appProperties: { app: "nsalek" } }] }), () => json({ files: [{ id: "b", name: "y", createdTime: "t" }] })]);
  const d = new HttpDrive(() => "tok", g.fetcher);
  const files = await d.list();
  assert.deepEqual(files.map((f) => [f.id, f.size]), [["a", 12], ["b", 0]]);
  const first = new URL(g.calls[0].url);
  assert.equal(first.searchParams.get("spaces"), "appDataFolder");
  assert.equal(new URL(g.calls[1].url).searchParams.get("pageToken"), "p2");
  assert.equal((g.calls[0].init!.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("google: a small copy goes in one request, into the hidden folder, bytes intact", async () => {
  const g = google([() => json({ id: "n", name: "c", createdTime: "t", size: "3", appProperties: { app: "nsalek" } })]);
  const d = new HttpDrive(() => "tok", g.fetcher);
  const f = await d.upload("c", new Uint8Array([0, 255, 7]), { app: "nsalek" });
  assert.equal(f.size, 3);
  const { url, init } = g.calls[0];
  assert.match(url, /upload\/drive\/v3\/files\?uploadType=multipart/);
  const body = new Uint8Array(await (init!.body as Blob).arrayBuffer());
  const text = new TextDecoder("latin1").decode(body);
  assert.match(text, /"parents":\["appDataFolder"\]/);
  const boundary = /boundary=(\S+)/.exec((init!.headers as Record<string, string>)["Content-Type"])![1];
  const start = text.indexOf("application/octet-stream\r\n\r\n") + "application/octet-stream\r\n\r\n".length;
  assert.deepEqual([...body.slice(start, start + 3)], [0, 255, 7]);
  assert.ok(text.endsWith(`\r\n--${boundary}--`));
});

test("google: a big copy goes in two steps", async () => {
  const g = google([
    () => json({}, 200, { Location: "https://upload.example/session1" }),
    () => json({ id: "n" }),
    () => json({ id: "n", name: "c", createdTime: "t", size: String(SIMPLE_MAX + 1), appProperties: { app: "nsalek" } }),
  ]);
  const d = new HttpDrive(() => "tok", g.fetcher);
  const f = await d.upload("c", new Uint8Array(SIMPLE_MAX + 1), {});
  assert.deepEqual([f.size, f.appProperties.app], [SIMPLE_MAX + 1, "nsalek"]);
  assert.match(g.calls[0].url, /uploadType=resumable/);
  assert.equal(g.calls[1].url, "https://upload.example/session1");
  assert.equal(g.calls[1].init!.method, "PUT");
  assert.match(g.calls[2].url, /files\/n\?fields=/, "the labels are read back, not trusted from the last answer");
});

test("google: answers become what a person can act on", async () => {
  const cases: [() => Response, string][] = [
    [fail(401), "drive_auth"],
    [fail(403, "storageQuotaExceeded"), "drive_full"],
    [fail(403, "quotaExceeded"), "drive_busy"],
    [fail(403, "dailyLimitExceeded"), "drive_busy"],
    [fail(403, "userRateLimitExceeded"), "drive_busy"],
    [fail(403, "accessNotConfigured"), "drive_off"],
    [fail(403, "insufficientPermissions"), "drive_denied"],
    [fail(404), "drive_gone"],
    [fail(429), "drive_busy"],
    [fail(503), "drive_busy"],
    [() => new Response("teapot", { status: 418 }), "drive_failed"],
  ];
  for (const [answer, code] of cases) {
    const d = new HttpDrive(() => "tok", google([answer]).fetcher);
    await assert.rejects(d.list(), (e: DriveError) => e.code === code, code);
  }
  await assert.rejects(new HttpDrive(() => "tok", google([]).fetcher).list(), (e: DriveError) => e.code === "drive_offline");
  const none = google([]);
  await assert.rejects(new HttpDrive(() => null, none.fetcher).list(), (e: DriveError) => e.code === "drive_auth");
  assert.equal(none.calls.length, 0, "nothing is sent without a permission");
  // Removing what is already gone is fine.
  await new HttpDrive(() => "tok", google([fail(404)]).fetcher).remove("x");
});

test("google: the account and its storage are read", async () => {
  const d = new HttpDrive(() => "tok", google([() => json({ user: { emailAddress: "a@b.c" }, storageQuota: { limit: "16106127360", usage: "1024" } })]).fetcher);
  assert.deepEqual(await d.about(), { email: "a@b.c", usage: 1024, limit: 16106127360 });
});

test("drive: a change counts until a copy taken after it, the demo notebook never", async () => {
  const { changedSince } = await import("../lib/drive/copy.ts"); // settings saved before signatures
  const h = await shop();
  const data = await loadLedger(h.store);
  assert.equal(changedSince(data, null), true);
  const last = data.audit.map((e) => e.at).sort().at(-1)!;
  assert.equal(changedSince(data, last), true, "the same millisecond may have missed it");
  assert.equal(changedSince(data, new Date(Date.parse(last) + 1).toISOString()), false);
  const empty = harness();
  await empty.run("createWorkspace", { name: "x", demo: true });
  assert.equal(changedSince(await loadLedger(empty.store), null), false);
});

test("drive: the screens use only texts that exist, in three languages", async () => {
  const { readFileSync } = await import("node:fs");
  const known = new Set([...readFileSync("lib/ui/driveText.ts", "utf8").matchAll(/^ {2}(\w+): \[/gm)].map((m) => m[1]));
  for (const [, k] of readFileSync("app/ui/Drive.tsx", "utf8").matchAll(/\bx\("(\w+)"\)/g)) assert.ok(known.has(k), k);
  for (const code of ["drive_auth", "drive_full", "drive_offline", "drive_busy", "drive_denied", "drive_off", "drive_gone", "drive_damaged", "drive_invalid", "drive_closed", "drive_popup", "drive_scope", "drive_failed"]) assert.ok(known.has(code), code);
});

// The reviewer's two cases: a loss that new entries would hide from a count.
const old = async (drive: FakeDrive, lost: (id: string) => (b: import("../lib/core/backup.ts").BackupFile) => boolean) => {
  let n = 0;
  for (const c of await listCopies(drive)) if (lost(c.id)(await readCopy(drive, c))) n++;
  return n;
};

test("drive: a photo removed by mistake stays in Drive, even after another photo is added", async () => {
  const { openBackup } = await import("../lib/core/backup.ts");
  const drive = new FakeDrive();
  const h = await basic();
  const ob = async () => (await h.run("createObligation", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(100), date: "2026-11-20" })).obligationId;
  const start = Date.parse("2026-11-26T07:00:00Z");
  let tick = 0;
  const next = () => at(start + ++tick * 10 * 60_000);
  await h.run("addAttachment", { workspaceId: h.workspaceId, ownerType: "obligation", ownerId: await ob(), name: "lost.jpg", mime: "image/jpeg", data: PHOTO, sha256: "0".repeat(64) });
  const lostId = (await loadLedger(h.store)).attachments[0].id;
  for (let i = 0; i < 3; i++) await saveCopy(drive, h.store, next());
  await h.run("removeAttachment", { id: lostId, attachmentId: lostId, reason: "oops" });
  for (let i = 0; i < 2; i++) await saveCopy(drive, h.store, next());
  await h.run("addAttachment", { workspaceId: h.workspaceId, ownerType: "obligation", ownerId: await ob(), name: "new.jpg", mime: "image/jpeg", data: PHOTO, sha256: "1".repeat(64) });
  for (let i = 0; i < 30; i++) await saveCopy(drive, h.store, next());
  const holding = await old(drive, () => (b) => (b as unknown as { payload: { attachments: { id: string }[] } }).payload.attachments.some((a) => a.id === lostId));
  assert.ok(holding >= 1, `${holding} copies hold the removed photo`);
  void openBackup;
});

test("drive: an older backup put back by mistake, then a morning of work: the lost entry stays in Drive", async () => {
  const { createBackup } = await import("../lib/core/backup.ts");
  const drive = new FakeDrive();
  // Time goes on between entries, as on a phone.
  let clock = Date.parse("2026-11-26T06:00:00Z");
  const h = await basic(undefined, () => new Date((clock += 60_000)));
  const ob = (n: number) => h.run("createObligation", { workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(n), date: "2026-11-20" });
  const start = Date.parse("2026-11-26T07:00:00Z");
  let tick = 0;
  const next = () => at(start + ++tick * 10 * 60_000);
  await ob(1);
  const older = await createBackup(await loadLedger(h.store), { now: new Date(start) });
  const { obligationId: lost } = await ob(77_777);
  for (let i = 0; i < 3; i++) await saveCopy(drive, h.store, next());
  await restoreBackup(h.store, older, { mode: "replace" });
  for (let i = 0; i < 40; i++) {
    await ob(10 + i);
    await saveCopy(drive, h.store, next());
  }
  const holding = await old(drive, () => (b) => (b as unknown as { payload: { obligations: { id: string }[] } }).payload.obligations.some((o) => o.id === lost));
  assert.ok(holding >= 1, `${holding} copies hold the lost entry`);
});

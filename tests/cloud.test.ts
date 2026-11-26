// The cloud copy: every danger of docs/cloud-design.md, against a cloud in memory.
import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { pack, unpack, fingerprint } from "../lib/cloud/bundle.ts";
import { threeWay } from "../lib/cloud/merge.ts";
import { CloudError, type CloudPort, type Head, type Save, type Version } from "../lib/cloud/port.ts";
import { claimPhone, everythingSaved, forgetAccount, removeForeign, removeSaved, restoreVersion, syncOnce, versionsToDrop, wipePhone, type About, type Choice } from "../lib/cloud/sync.ts";
import { createBackup, SCHEMA_VERSION, validateLedger } from "../lib/core/backup.ts";
import { restoreBackup } from "../lib/core/restore.ts";
import { backupStatus } from "../lib/core/quickBackup.ts";
import { partyBalance } from "../lib/core/ledger.ts";
import { MemoryStore, type Store } from "../lib/core/store.ts";
import { openStore } from "../lib/storage/idb.ts";
import { seedDemo } from "../lib/demo.ts";
import { DA, harness, loadAll, TODAY, type R } from "./helpers.ts";

/** A cloud that keeps or refuses, and can lose an answer or a connection. */
class FakeCloud implements CloudPort {
  h: Head | null = null;
  blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  loseAnswer = false;
  offline = false;
  saves = 0;
  clock = Date.parse("2026-11-22T10:00:00Z");
  async head() {
    if (this.offline) throw new CloudError("cloud_offline");
    return structuredClone(this.h);
  }
  async read(v: Version) {
    const b = this.blobs.get(v.id);
    if (!b) throw new CloudError("cloud_corrupt");
    return b.slice();
  }
  async save(s: Save) {
    if (this.offline) throw new CloudError("cloud_offline");
    const ok = s.after ? this.h?.rev === s.after.rev && this.h?.lineage === s.after.lineage : this.h === null;
    if (!ok) throw new CloudError("cloud_moved");
    this.clock += 60_000;
    this.h = { ...structuredClone(s.head), updatedAt: new Date(this.clock).toISOString() };
    this.blobs.set(s.add.version.id, s.add.bytes.slice());
    for (const d of s.drop) this.blobs.delete(d.id);
    this.saves++;
    if (this.loseAnswer) {
      this.loseAnswer = false;
      throw new CloudError("cloud_offline");
    }
  }
  async deleteAll() {
    this.h = null;
    this.blobs.clear();
  }
}

const A = { uid: "uidA", email: "a@example.com", device: "phone" };

type Phone = ReturnType<typeof phone>;
function phone(cloud: CloudPort, store: Store = new MemoryStore(), who = A) {
  const h = harness(store);
  const ready = store.run("readwrite", async (tx) => {
    if (!(await tx.get("meta", "app"))) await tx.put("meta", { id: "app", schemaVersion: 1, deviceId: "d", activeWorkspaceId: null });
  });
  const seen: { applied: number; about?: About } = { applied: 0 };
  // As on the screen: a choice goes with the situation that was shown.
  const sync = async (choice?: Choice) => {
    await ready;
    const s = await syncOnce(store, cloud, { ...who, choice, about: seen.about, onApplied: () => seen.applied++ });
    seen.about = s.kind === "choose" ? { reason: s.reason, versionId: s.head?.versionId ?? null } : undefined;
    return s;
  };
  const meta = () => store.run("readonly", (tx) => tx.get("meta", "app"));
  const data = () => loadAll(store);
  return { ...h, sync, meta, data, who, seen };
}

let k = 0;
async function notebook(p: Phone, name = "Karim") {
  const { workspaceId } = await p.run("createWorkspace", { name: "Carnet" });
  const { partyId } = await p.run("createParty", { workspaceId, displayName: name + ++k });
  return { workspaceId, partyId };
}
const debt = (p: Phone, n: { workspaceId: string; partyId: string }, amount: number) =>
  p.run("createObligation", { ...n, direction: "receivable", currency: "DZD", principal: DA(amount), date: "2026-11-01" });
const pay = (p: Phone, n: { workspaceId: string; partyId: string }, amount: number) =>
  p.run("recordPayment", { ...n, direction: "receivable", currency: "DZD", amount: DA(amount), date: "2026-11-02" });
const owed = async (p: Phone, n: { workspaceId: string; partyId: string }) => partyBalance(await p.index(n.workspaceId), n.partyId, TODAY).get("DZD")?.receivable ?? 0;

/** Two phones that share one notebook with one debt of 1,000. */
async function twoPhones() {
  const cloud = new FakeCloud();
  const a = phone(cloud);
  const n = await notebook(a);
  await debt(a, n, 1000);
  assert.equal((await a.sync()).kind, "saved");
  const b = phone(cloud);
  assert.equal((await b.sync()).kind, "pulled");
  return { cloud, a, b, n };
}

test("first save, then nothing to do, then only what changed", async () => {
  const cloud = new FakeCloud();
  const p = phone(cloud);
  assert.equal((await p.sync()).kind, "empty");
  const n = await notebook(p);
  await debt(p, n, 1000);
  assert.equal((await p.sync()).kind, "saved");
  assert.equal((await p.sync()).kind, "up_to_date");
  assert.equal(cloud.saves, 1);
  await pay(p, n, 400);
  assert.equal((await p.sync()).kind, "saved");
  assert.equal(cloud.h!.rev, 2);
  assert.equal(cloud.h!.versions.length, 2);
});

test("new phone: everything comes back, identical and valid, and the notebook opens", async () => {
  const { a, b, n } = await twoPhones();
  assert.equal(fingerprint(await b.data()), fingerprint(await a.data()));
  assert.deepEqual(validateLedger(await b.data()), []);
  assert.equal(await owed(b, n), DA(1000));
  assert.equal((await b.meta())!.activeWorkspaceId, n.workspaceId);
});

test("the same on the real phone database (IndexedDB), also after closing it", async () => {
  const cloud = new FakeCloud();
  const a = phone(cloud);
  const n = await notebook(a);
  await debt(a, n, 1000);
  await a.sync();
  const factory = new IDBFactory();
  const s1 = await openStore("c1", factory);
  assert.equal((await phone(cloud, s1).sync()).kind, "pulled");
  s1.close();
  const s2 = await openStore("c1", factory);
  const b = phone(cloud, s2);
  assert.equal(await owed(b, n), DA(1000));
  assert.equal((await b.sync()).kind, "up_to_date");
  await pay(b, n, 300);
  assert.equal((await b.sync()).kind, "saved");
  assert.equal((await a.sync()).kind, "pulled");
  assert.equal(await owed(a, n), DA(700));
  s2.close();
});

test("one phone after the other: the newer copy comes down by itself", async () => {
  const { a, b, n } = await twoPhones();
  await pay(a, n, 250);
  await a.sync();
  assert.equal((await b.sync()).kind, "pulled");
  assert.equal(await owed(b, n), DA(750));
  await pay(b, n, 250);
  await b.sync();
  assert.equal((await a.sync()).kind, "pulled");
  assert.equal(await owed(a, n), DA(500));
});

test("entries made on both phones are combined by themselves, none lost, none twice", async () => {
  const { a, b, n } = await twoPhones();
  await pay(a, n, 100);
  await debt(a, n, 50);
  await pay(b, n, 200);
  const { partyId } = await b.run("createParty", { workspaceId: n.workspaceId, displayName: "Samira" });
  await debt(b, { ...n, partyId }, 70);
  await a.sync();
  assert.equal((await b.sync()).kind, "combined");
  assert.equal((await a.sync()).kind, "pulled");
  for (const p of [a, b]) {
    assert.equal(await owed(p, n), DA(1000 - 100 + 50 - 200));
    assert.equal(await owed(p, { ...n, partyId }), DA(70));
    assert.deepEqual(validateLedger(await p.data()), []);
  }
  assert.equal(fingerprint(await a.data()), fingerprint(await b.data()));
});

test("the same debt paid in full on both phones is not decided alone; the copy not chosen is kept", async () => {
  const { cloud, a, b, n } = await twoPhones();
  await pay(a, n, 1000);
  await pay(b, n, 1000);
  await a.sync();
  const s = (await b.sync()) as R;
  assert.equal(s.kind, "choose");
  assert.equal(s.reason, "both_changed");
  assert.equal(s.canCombine, false);
  assert.equal((await b.data()).payments.length, 1, "nothing was changed on the phone");
  const mineBefore = fingerprint(await b.data());
  assert.equal((await b.sync("combine")).kind, "choose", "a forbidden combination is not done on request either");
  assert.equal((await b.sync("keep_cloud")).kind, "pulled");
  assert.equal(await owed(b, n), 0);
  assert.equal(fingerprint(await b.data()), fingerprint(await a.data()));
  const pinned = cloud.h!.versions.find((v) => v.pinned)!;
  assert.equal(fingerprint((await unpack(cloud.blobs.get(pinned.id)!, pinned.encoding)).data), mineBefore);
  assert.equal((await a.sync()).kind, "up_to_date");
});

test("keeping this phone's copy keeps the cloud's as an older copy", async () => {
  const { cloud, a, b, n } = await twoPhones();
  await pay(a, n, 1000);
  await pay(b, n, 1000);
  await a.sync();
  const theirs = cloud.h!.versionId;
  assert.equal((await b.sync("keep_phone")).kind, "choose", "nothing was shown yet, so nothing was chosen");
  assert.equal((await b.sync("keep_phone")).kind, "saved");
  assert.ok(cloud.h!.versions.find((v) => v.id === theirs)!.pinned);
  assert.ok(cloud.blobs.has(theirs));
  assert.equal((await a.sync()).kind, "pulled");
});

test("a save whose answer was lost is not a conflict, even when entries follow", async () => {
  const cloud = new FakeCloud();
  const p = phone(cloud);
  const n = await notebook(p);
  await debt(p, n, 1000);
  cloud.loseAnswer = true;
  await assert.rejects(p.sync(), /cloud_offline/);
  assert.equal(cloud.saves, 1);
  await p.run("updateParty", { partyId: n.partyId, changes: { notes: "changed after the lost answer" } });
  await pay(p, n, 100);
  assert.equal((await p.sync()).kind, "saved");
  assert.equal((await p.sync()).kind, "up_to_date");
  assert.equal(await owed(p, n), DA(900));
  // And the other phone's change after the lost answer is combined, not taken for a conflict.
  const b = phone(cloud);
  await b.sync();
  await pay(p, n, 10);
  cloud.loseAnswer = true;
  await assert.rejects(p.sync());
  await b.sync();
  await pay(b, n, 20);
  await b.sync();
  await pay(p, n, 30);
  // Changed on both sides since the save before the lost one: only the lost one explains it.
  await p.run("updateParty", { partyId: n.partyId, changes: { notes: "after" } });
  assert.equal((await p.sync()).kind, "combined");
  assert.equal(await owed(p, n), DA(840));
});

test("a lost save that another phone built on is still the common copy", async () => {
  const { cloud, a, b, n } = await twoPhones();
  await a.run("updateParty", { partyId: n.partyId, changes: { notes: "first" } });
  cloud.loseAnswer = true;
  await assert.rejects(a.sync());
  await b.sync();
  await pay(b, n, 20);
  await b.sync();
  await a.run("updateParty", { partyId: n.partyId, changes: { notes: "second" } });
  assert.equal((await a.sync()).kind, "combined");
  assert.equal((await a.data()).parties.find((x) => x.id === n.partyId)!.notes, "second");
  assert.equal(await owed(a, n), DA(980));
});

test("without a connection nothing changes, and it is sent later exactly once", async () => {
  const { cloud, a, n } = await twoPhones();
  cloud.offline = true;
  await pay(a, n, 100);
  await assert.rejects(a.sync(), /cloud_offline/);
  assert.equal(await everythingSaved(a.store, A.uid), false);
  assert.equal(await owed(a, n), DA(900));
  cloud.offline = false;
  assert.equal((await a.sync()).kind, "saved");
  assert.equal(await everythingSaved(a.store, A.uid), true);
});

test("a damaged cloud copy is refused and the phone keeps its data", async () => {
  const { cloud, a, b, n } = await twoPhones();
  await pay(a, n, 100);
  await a.sync();
  const before = fingerprint(await b.data());
  const good = cloud.blobs.get(cloud.h!.versionId)!;
  for (const bad of [good.slice(0, 40), new Uint8Array([1, 2, 3]), new Uint8Array(0)]) {
    cloud.blobs.set(cloud.h!.versionId, bad);
    assert.equal(((await b.sync()) as R).reason, "cloud_unreadable");
    assert.equal(fingerprint(await b.data()), before);
  }
  // Whole, but not the copy that was announced.
  cloud.blobs.set(cloud.h!.versionId, cloud.blobs.get(cloud.h!.versions[0].id)!);
  assert.equal(((await b.sync()) as R).reason, "cloud_unreadable");
  assert.equal(fingerprint(await b.data()), before);
  cloud.blobs.set(cloud.h!.versionId, good);
  assert.equal((await b.sync()).kind, "pulled");
});

test("an entry made while a copy arrives is not overwritten", async () => {
  const { cloud, a, b, n } = await twoPhones();
  await pay(a, n, 100);
  await a.sync();
  const read = cloud.read.bind(cloud);
  cloud.read = async (v) => {
    await pay(b, n, 200);
    return read(v);
  };
  assert.equal((await b.sync()).kind, "again");
  cloud.read = read;
  assert.equal(await owed(b, n), DA(800));
  assert.equal((await b.sync()).kind, "combined");
  assert.equal(await owed(b, n), DA(700));
});

test("another account on the same phone neither sends nor receives", async () => {
  const cloudA = new FakeCloud();
  const a = phone(cloudA);
  const n = await notebook(a);
  await debt(a, n, 1000);
  await a.sync();
  const cloudB = new FakeCloud();
  const b = phone(cloudB, a.store, { uid: "uidB", email: "b@example.com", device: "phone" });
  const s = (await b.sync()) as R;
  assert.deepEqual([s.kind, s.email], ["foreign", "a@example.com"]);
  assert.equal(cloudB.h, null);
  assert.equal((await b.sync("keep_phone")).kind, "foreign", "no choice opens it");
  // After removing A's notebook from the phone, B starts clean.
  await wipePhone(a.store);
  assert.equal((await b.sync()).kind, "empty");
  assert.equal((await a.data()).parties.length, 0);
  // A signs in again and gets everything back.
  assert.equal((await a.sync()).kind, "pulled");
  assert.equal(await owed(a, n), DA(1000));
});

test("a notebook can be taken to another account, only at the person's wish and replacing nothing there", async () => {
  const cloudA = new FakeCloud();
  const a = phone(cloudA);
  const n = await notebook(a);
  await debt(a, n, 1000);
  await a.sync();
  const who = { uid: "uidB", email: "b@example.com", device: "phone" };
  const cloudB = new FakeCloud();
  const b = phone(cloudB, a.store, who);
  assert.equal((await b.sync()).kind, "foreign");
  await claimPhone(a.store, who);
  assert.equal((await b.sync()).kind, "saved");
  assert.equal(await owed(phone(cloudB, a.store, who), n), DA(1000));
  // The first account, opened again on this phone, is the foreign one now, and keeps its copy.
  assert.equal((await a.sync()).kind, "foreign");
  assert.equal(cloudA.h!.rev, 1);
  // Into an account that already has a notebook: asked first.
  const cloudC = new FakeCloud();
  const c = phone(cloudC, undefined, { uid: "uidC", email: "c@example.com", device: "other" });
  await debt(c, await notebook(c), 5);
  await c.sync();
  await claimPhone(a.store, { uid: "uidC", email: "c@example.com" });
  const s = (await phone(cloudC, a.store, { uid: "uidC", email: "c@example.com", device: "phone" }).sync()) as R;
  assert.deepEqual([s.kind, s.reason], ["choose", "first_link"]);
  assert.equal(cloudC.saves, 1);
});

test("a phone remembers its account even when nothing is saved yet or a choice is waiting", async () => {
  const cloud = new FakeCloud();
  const p = phone(cloud);
  assert.equal((await p.sync()).kind, "empty");
  assert.equal((await p.meta())!.cloud!.uid, A.uid);
  const other = phone(cloud);
  await debt(other, await notebook(other), 10);
  await other.sync();
  const own = phone(cloud);
  await debt(own, await notebook(own), 20);
  assert.equal((await own.sync()).kind, "choose");
  assert.equal((await own.meta())!.cloud!.uid, A.uid);
  assert.equal((await own.meta())!.cloud!.link, undefined);
  // Nothing was sent or received yet, so another account is not refused.
  const cloudB = new FakeCloud();
  assert.equal((await phone(cloudB, own.store, { uid: "uidB", email: "b@example.com", device: "phone" }).sync()).kind, "saved");
});

test("the screens are told when the notebooks changed, also when a later step fails", async () => {
  const { cloud, a, b, n } = await twoPhones();
  assert.deepEqual([a.seen.applied, b.seen.applied], [0, 1]);
  await pay(a, n, 100);
  await a.sync();
  assert.equal(a.seen.applied, 0, "saving changes nothing here");
  await debt(b, n, 50);
  const save = cloud.save;
  cloud.save = async () => {
    throw new CloudError("cloud_offline");
  };
  await assert.rejects(b.sync(), /cloud_offline/);
  cloud.save = save;
  assert.equal(b.seen.applied, 2, "combined here, not sent yet");
  assert.equal(await owed(b, n), DA(950));
  assert.equal((await b.sync()).kind, "saved");
  let told = 0;
  const old = cloud.h!.versions.find((v) => v.rev === 1)!;
  await restoreVersion(a.store, cloud, { ...A, onApplied: () => told++ }, old.id);
  assert.equal(told, 2, "the newer copy came down, then the older one was put back");
});

test("before choosing, the people it is about are named", async () => {
  const { a, b, n } = await twoPhones();
  const name = (await a.data()).parties[0].displayName;
  await pay(a, n, 1000);
  await a.sync();
  await pay(b, n, 1000);
  const s = (await b.sync()) as R;
  assert.equal(s.kind, "choose");
  assert.deepEqual(s.people, [name]);
});

test("a phone with its own notebook joining an account that has another: asked first, then both", async () => {
  const cloud = new FakeCloud();
  const a = phone(cloud);
  const na = await notebook(a, "Cloud");
  await debt(a, na, 1000);
  await a.sync();
  const b = phone(cloud);
  const nb = await notebook(b, "Phone");
  await debt(b, nb, 300);
  const s = (await b.sync()) as R;
  assert.deepEqual([s.kind, s.reason, s.canCombine], ["choose", "first_link", true]);
  assert.equal(cloud.saves, 1);
  assert.equal((await b.sync("combine")).kind, "combined");
  assert.equal(await owed(b, na), DA(1000));
  assert.equal(await owed(b, nb), DA(300));
  assert.equal((await a.sync()).kind, "pulled");
  assert.equal(await owed(a, nb), DA(300));
});

test("a phone with only an empty new notebook takes the account's notebook by itself", async () => {
  const { cloud, n } = await twoPhones();
  const c = phone(cloud);
  await c.run("createWorkspace", { name: "Mon carnet" });
  assert.equal((await c.sync()).kind, "pulled");
  assert.equal(await owed(c, n), DA(1000));
  assert.deepEqual((await c.data()).workspaces.map((w) => w.id), [n.workspaceId]);
});

test("a phone that lost its notebook but not its link does not empty the cloud", async () => {
  const { cloud, a, n } = await twoPhones();
  await a.store.run("readwrite", async (tx) => {
    for (const s of ["parties", "obligations", "payments", "allocations", "adjustments", "audit", "workspaces"] as const) await tx.clear(s);
  });
  await a.run("createWorkspace", { name: "x" });
  assert.equal((await a.sync()).kind, "pulled");
  assert.equal(await owed(a, n), DA(1000));
  assert.equal(cloud.saves, 1);
});

test("a deleted, replaced or rolled-back cloud copy always asks", async () => {
  const { cloud, a, b, n } = await twoPhones();
  await pay(a, n, 10);
  await a.sync();
  const now = structuredClone(cloud.h);
  const blobs = new Map(cloud.blobs);
  // Rolled back to an earlier revision.
  cloud.h = { ...now!, rev: 1, versionId: now!.versions[0].id };
  assert.equal(((await a.sync()) as R).kind, "choose");
  assert.equal(await owed(a, n), DA(990));
  // Deleted.
  await cloud.deleteAll();
  let s = (await a.sync()) as R;
  assert.deepEqual([s.kind, s.reason], ["choose", "cloud_deleted"]);
  // Made anew by the other phone's owner.
  assert.equal((await b.sync()).kind, "choose");
  assert.equal((await b.sync("keep_phone")).kind, "saved");
  s = (await a.sync()) as R;
  assert.deepEqual([s.kind, s.reason], ["choose", "cloud_replaced"]);
  cloud.h = now;
  cloud.blobs = blobs;
  assert.equal((await a.sync()).kind, "up_to_date");
});

test("a cloud copy made anew is not taken for a newer one, even when its number is higher", async () => {
  const { cloud, a, n } = await twoPhones();
  await cloud.deleteAll();
  const other = phone(cloud);
  const m = await notebook(other, "Other");
  await other.sync();
  await debt(other, m, 5);
  await other.sync();
  assert.equal(cloud.h!.rev, 2);
  const s = (await a.sync()) as R; // unchanged since its own save, number 1
  assert.deepEqual([s.kind, s.reason], ["choose", "cloud_replaced"]);
  assert.equal(await owed(a, n), DA(1000));
});

test("a whole copy with an impossible ledger is refused", async () => {
  const { a } = await twoPhones();
  const data = await a.data();
  data.allocations.push({ id: "x", workspaceId: data.workspaces[0].id, paymentId: "none", obligationId: data.obligations[0].id, partyId: data.parties[0].id, amount: 5, date: TODAY, createdAt: "" });
  const p = await pack(data, { now: new Date() });
  await assert.rejects(unpack(p.bytes, p.encoding), /cloud_corrupt/);
});

test("an older app does not write over a newer format", async () => {
  const { cloud, a, n } = await twoPhones();
  cloud.h!.versions[0].schemaVersion = SCHEMA_VERSION + 1;
  cloud.h!.rev = 2;
  cloud.h!.versions[0].sha = "other";
  await pay(a, n, 10);
  await assert.rejects(a.sync(), /cloud_update_app/);
  await assert.rejects(a.sync("keep_phone"), /cloud_update_app/);
  assert.equal(cloud.saves, 1);
});

test("two saves at the same moment: one is refused, then combined", async () => {
  const { cloud, a, b, n } = await twoPhones();
  await pay(a, n, 100);
  await pay(b, n, 200);
  const r = await Promise.allSettled([a.sync(), b.sync()]);
  const refused = r.filter((x) => x.status === "rejected");
  assert.equal(refused.length, 1);
  assert.match(String((refused[0] as PromiseRejectedResult).reason), /cloud_moved/);
  await a.sync();
  await b.sync();
  await a.sync();
  assert.equal(await owed(a, n), DA(700));
  assert.equal(await owed(b, n), DA(700));
  assert.ok(cloud.h!.rev >= 3);
});

test("the demo notebook and photos stay on the phone; photos survive a copy coming down", async () => {
  const cloud = new FakeCloud();
  const a = phone(cloud);
  const n = await notebook(a);
  const { obligationId } = await debt(a, n, 1000);
  await a.run("addAttachment", { workspaceId: n.workspaceId, ownerType: "obligation", ownerId: obligationId, name: "recu.png", mime: "image/png", data: "aGVsbG8=", sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" });
  await seedDemo(a.run as never, { lang: "fr", mode: "personal", today: TODAY });
  const all = await a.data();
  const sent = (await unpack((await pack(all, { now: new Date() })).bytes, "gzip")).data;
  assert.equal(sent.attachments.length, 0);
  assert.equal(sent.workspaces.length, 1);
  await a.sync();
  const b = phone(cloud);
  await b.sync();
  await pay(b, n, 100);
  await b.sync();
  assert.equal((await a.sync()).kind, "pulled");
  const after = await a.data();
  assert.equal(after.attachments.length, 1);
  assert.equal(after.workspaces.filter((w) => w.demo).length, 1);
  assert.equal(after.obligations.filter((o) => o.workspaceId !== n.workspaceId).length, all.obligations.length - 1);
});

test("an older copy can be put back; the present state stays available", async () => {
  const { cloud, a, b, n } = await twoPhones();
  const first = cloud.h!.versionId;
  await pay(a, n, 400);
  await a.sync();
  const s = await restoreVersion(a.store, cloud, A, first);
  assert.equal(s.kind, "saved");
  assert.equal(await owed(a, n), DA(1000));
  assert.equal((await b.sync()).kind, "up_to_date");
  const back = cloud.h!.versions.find((v) => v.rev === 2)!;
  await restoreVersion(a.store, cloud, A, back.id);
  assert.equal(await owed(a, n), DA(600));
  await assert.rejects(restoreVersion(a.store, cloud, A, "nope"), /cloud_version_gone/);
});

test("an older copy can be put back even when saving the present pushes it out of the list", async () => {
  const { cloud, a, n } = await twoPhones();
  const first = cloud.h!.versionId;
  for (let i = 0; i < 2; i++) {
    await pay(a, n, 10);
    await a.sync();
  }
  await pay(a, n, 10);
  await restoreVersion(a.store, cloud, A, first);
  assert.ok(!cloud.h!.versions.some((v) => v.id === first), "the case this test is about");
  assert.equal(await owed(a, n), DA(1000));
});

test("recurring debts made by both phones on the same day are one debt", async () => {
  const { a, b, n } = await twoPhones();
  await a.run("createRecurringPlan", { ...n, direction: "receivable", currency: "DZD", amount: DA(2000), description: "Loyer", frequency: "monthly", startDate: "2026-11-01" });
  await a.sync();
  await b.sync();
  await a.run("generateRecurring", { workspaceId: n.workspaceId });
  const later = harness(b.store, () => new Date("2026-11-22T11:30:00Z"));
  await later.run("generateRecurring", { workspaceId: n.workspaceId });
  await a.sync();
  assert.equal((await b.sync()).kind, "combined");
  assert.equal(await owed(b, n), DA(3000));
  assert.equal((await b.data()).obligations.length, 2);
});

test("what is right on each phone but wrong together is never combined", async () => {
  // A person merged on one phone gets a new debt on the other.
  const t1 = await twoPhones();
  const { partyId: dup } = await t1.a.run("createParty", { workspaceId: t1.n.workspaceId, displayName: "Doublon" });
  await t1.a.sync();
  await t1.b.sync();
  await t1.a.run("mergeParties", { sourceId: dup, targetId: t1.n.partyId, reason: "same" });
  await debt(t1.b, { ...t1.n, partyId: dup }, 50);
  await t1.a.sync();
  assert.equal(((await t1.b.sync()) as R).kind, "choose");
  // The same person renamed differently.
  const t3 = await twoPhones();
  await t3.a.run("updateParty", { partyId: t3.n.partyId, changes: { displayName: "Nom A" } });
  await t3.b.run("updateParty", { partyId: t3.n.partyId, changes: { displayName: "Nom B" } });
  await t3.a.sync();
  assert.equal(((await t3.b.sync()) as R).kind, "choose");
});

test("a correction written for another person than its debt's is never combined", async () => {
  const { a, n } = await twoPhones();
  const { partyId: other } = await a.run("createParty", { workspaceId: n.workspaceId, displayName: "Autre" });
  const base = await a.data();
  const local = structuredClone(base);
  local.obligations[0].partyId = other;
  const remote = structuredClone(base);
  remote.adjustments.push({ id: "adj_x", workspaceId: n.workspaceId, obligationId: base.obligations[0].id, partyId: n.partyId, type: "decrease", amount: 5, date: TODAY, reason: "x", createdAt: "2026-11-02T00:00:00Z", createdBy: "x" });
  assert.deepEqual(threeWay(base, local, remote).conflicts, [{ store: "adjustments", id: "adj_x" }]);
});

test("without the common copy the comparison is stricter, never looser", async () => {
  const { a, b, n } = await twoPhones();
  await a.run("updateParty", { partyId: n.partyId, changes: { notes: "x" } });
  await pay(b, n, 10);
  await a.sync();
  await b.store.run("readwrite", (tx) => tx.delete("snapshots", "cloud_base"));
  assert.equal(((await b.sync()) as R).kind, "choose");
  const empty = (await loadAll(new MemoryStore())) as R;
  assert.equal(threeWay(null, empty, empty).conflicts.length, 0);
});

test("kept versions: current, pinned, newest, days, weeks and months; bounded", () => {
  const v = (rev: number, at: string, pinned = false): Version => ({ id: "v" + rev, rev, at, device: "d", bytes: 1, parts: 1, encoding: "gzip", sha: "s" + rev, schemaVersion: 1, people: 1, entries: 1, pinned });
  const list: Version[] = [];
  for (let i = 0; i < 400; i++) list.push(v(i + 1, new Date(Date.UTC(2026, 0, 1) + i * 12 * 3600_000).toISOString(), i === 7));
  const dropped = new Set(versionsToDrop(list, "v3").map((x) => x.id));
  const kept = list.filter((x) => !dropped.has(x.id));
  assert.ok(kept.some((x) => x.id === "v3") && kept.some((x) => x.id === "v8"), "current and pinned stay");
  assert.ok(["v400", "v399", "v398"].every((id) => !dropped.has(id)));
  assert.ok(kept.length <= 3 + 7 + 4 + 6 + 2, `${kept.length} kept`);
  assert.ok(kept.some((x) => x.at.startsWith("2026-03")), "a copy of months ago is still there");
  // Many saves in a day keep few.
  const busy = Array.from({ length: 60 }, (_, i) => v(i + 1, new Date(Date.UTC(2026, 5, 1, 8, i)).toISOString()));
  assert.equal(60 - versionsToDrop(busy, "v60").length, 3);
});

test("a day of many saves keeps the cloud small, and every listed copy opens", async () => {
  const { cloud, a, n } = await twoPhones();
  for (let i = 0; i < 25; i++) {
    await debt(a, n, 1 + i);
    await a.sync();
  }
  assert.ok(cloud.h!.versions.length <= 6, `${cloud.h!.versions.length}`);
  assert.deepEqual([...cloud.blobs.keys()].sort(), cloud.h!.versions.map((v) => v.id).sort());
  for (const v of cloud.h!.versions) assert.equal((await unpack(cloud.blobs.get(v.id)!, v.encoding)).sha, v.sha);
});

test("an entry made while a save is on its way still counts as not saved", async () => {
  const { cloud, a, n } = await twoPhones();
  await pay(a, n, 1);
  const save = cloud.save.bind(cloud);
  cloud.save = async (s) => {
    await new Promise((r) => setTimeout(r, 30));
    await pay(a, n, 2);
    return save(s);
  };
  await a.sync();
  cloud.save = save;
  const link = (await a.meta())!.cloud!.link!;
  assert.equal(await everythingSaved(a.store, A.uid), false);
  assert.ok(Date.parse(link.savedAt) <= Date.now() - 25, "speaks for the moment the phone was read");
  assert.equal((await a.sync()).kind, "saved");
  assert.equal(await everythingSaved(a.store, A.uid), true);
});

test("looking without any change writes nothing on the phone", async () => {
  const { a } = await twoPhones();
  let writes = 0;
  const run = a.store.run.bind(a.store);
  a.store.run = ((mode: "readonly" | "readwrite", fn: never) => {
    if (mode === "readwrite") writes++;
    return run(mode, fn);
  }) as never;
  assert.equal((await a.sync()).kind, "up_to_date");
  assert.equal(writes, 0);
});

test("signing out with removal needs everything saved; the backup reminder counts the cloud copy", async () => {
  const { a, n } = await twoPhones();
  assert.equal(await everythingSaved(a.store, A.uid), true);
  assert.equal(await everythingSaved(a.store, "someone else"), false);
  await pay(a, n, 1);
  assert.equal(await everythingSaved(a.store, A.uid), false);
  const data = await a.data();
  const now = new Date("2026-11-23T10:00:00Z");
  assert.notEqual(backupStatus(data, null, now).level, "ok");
  const s = backupStatus(data, null, now, "2026-11-22T12:00:00Z");
  assert.deepEqual([s.level, s.changes], ["ok", 0]);
  // Not in the cloud yet: normal for a moment, worth a reminder after days.
  const behind = (now: string, backup: string | null = null) => backupStatus(data, backup, new Date(now), "2026-11-22T09:59:59Z").level;
  assert.equal(behind("2026-11-22T10:05:00Z"), "ok");
  assert.equal(behind("2026-11-25T10:00:01Z"), "due");
  assert.equal(behind("2026-11-29T10:00:01Z"), "urgent");
  assert.equal(behind("2026-11-25T10:00:01Z", "2026-11-01T10:00:00Z"), "due");
  assert.equal(behind("2026-11-22T10:05:00Z", "2026-11-01T10:00:00Z"), "ok");
});

// ---------------------------------------------------------------- found by the independent review (2026-11-25)

const snapshots = (p: Phone) => p.store.run("readonly", async (tx) => (await tx.all("snapshots")).filter((s) => !s.bytes));
const B = { uid: "uidB", email: "b@example.com", device: "phone" };
const C = { uid: "uidC", email: "c@example.com", device: "phone" };

test("deleting an account does not release another account's notebook", async () => {
  const a = phone(new FakeCloud());
  await debt(a, await notebook(a), 1000);
  await a.sync();
  await forgetAccount(a.store, B.uid);
  const cloudC = new FakeCloud();
  assert.equal((await phone(cloudC, a.store, C).sync()).kind, "foreign");
  assert.equal(cloudC.h, null);
  await forgetAccount(a.store, A.uid);
  assert.equal((await a.meta())!.cloud, null);
});

test("an empty notebook with a shop's name and numbers does not go to another account either", async () => {
  const a = phone(new FakeCloud());
  await a.run("createWorkspace", { name: "Boutique A", mode: "business", business: { name: "Boutique A", phone: "0550000000", taxId: "123" } });
  await a.sync();
  const cloudB = new FakeCloud();
  assert.equal((await phone(cloudB, a.store, B).sync()).kind, "foreign");
  assert.equal(cloudB.h, null);
});

test("another backup file put in place of the notebook asks before it replaces the account's copy", async () => {
  const { cloud, a, b, n } = await twoPhones();
  const other = phone(new FakeCloud());
  await debt(other, await notebook(other, "Other"), 5);
  await restoreBackup(a.store, await createBackup(await other.data(), {}), { mode: "replace" });
  const s = (await a.sync()) as R;
  assert.deepEqual([s.kind, s.reason], ["choose", "first_link"]);
  assert.equal(cloud.saves, 1);
  assert.equal((await phone(new FakeCloud(), a.store, B).sync()).kind, "foreign", "still not anybody's");
  // Chosen: the copy it replaces is kept whatever its age.
  const replaced = cloud.h!.versionId;
  assert.equal((await a.sync("keep_phone")).kind, "saved");
  for (let i = 0; i < 6; i++) {
    await a.run("createWorkspace", { name: "W" + i });
    await a.sync();
  }
  assert.ok(cloud.h!.versions.some((v) => v.id === replaced && v.pinned));
  assert.equal((await b.sync()).kind, "pulled");
  void n;
});

test("a file put in place of the notebook while a save is on its way is not sent either", async () => {
  const when = [
    // While the save is being sent.
    (cloud: FakeCloud, restore: () => Promise<unknown>) => {
      const save = cloud.save.bind(cloud);
      cloud.save = async (s) => {
        cloud.save = save;
        await restore();
        return save(s);
      };
    },
    // While the cloud is asked, before anything is sent.
    (cloud: FakeCloud, restore: () => Promise<unknown>) => {
      const ask = cloud.head.bind(cloud);
      cloud.head = async () => {
        cloud.head = ask;
        const h = await ask();
        await restore();
        return h;
      };
    },
  ];
  for (const arrange of when)
    for (const changed of [true, false]) {
      const { cloud, a, b, n } = await twoPhones();
      const other = phone(new FakeCloud());
      await debt(other, await notebook(other, "Other"), 5);
      const file = await createBackup(await other.data(), {});
      if (changed) await pay(a, n, 10);
      else if (arrange === when[0]) continue; // nothing would be sent
      arrange(cloud, () => restoreBackup(a.store, file, { mode: "replace" }));
      await a.sync();
      assert.equal((await a.meta())!.cloud!.link, undefined);
      assert.equal(((await a.sync()) as R).kind, "choose");
      await b.sync();
      assert.equal((await b.data()).workspaces[0].id, n.workspaceId);
    }
  // The same while a lost answer is recognised, and while an identical copy is taken over.
  const { cloud, a, n } = await twoPhones();
  const other = phone(new FakeCloud());
  await debt(other, await notebook(other, "Other"), 5);
  const file = await createBackup(await other.data(), {});
  await pay(a, n, 10);
  cloud.loseAnswer = true;
  await assert.rejects(a.sync());
  when[1](cloud, () => restoreBackup(a.store, file, { mode: "replace" }));
  assert.equal((await a.sync()).kind, "again");
  assert.equal(((await a.sync()) as R).kind, "choose");
  const t = await twoPhones();
  await t.a.store.run("readwrite", async (tx) => {
    const m = (await tx.get("meta", "app"))!;
    await tx.put("meta", { ...m, cloud: { ...m.cloud!, link: undefined } });
  });
  when[1](t.cloud, () => restoreBackup(t.a.store, file, { mode: "replace" }));
  assert.equal((await t.a.sync()).kind, "again");
  assert.equal(((await t.a.sync()) as R).kind, "choose");
});

test("putting the same notebook back from a file asks nothing", async () => {
  const { cloud, a } = await twoPhones();
  await restoreBackup(a.store, await createBackup(await a.data(), {}), { mode: "replace" });
  assert.equal((await a.sync()).kind, "up_to_date");
  assert.equal(cloud.saves, 1);
});

test("removing the notebook from the phone needs the cloud to have it now, not once", async () => {
  // Deleted elsewhere.
  const one = await twoPhones();
  await one.cloud.deleteAll();
  assert.equal(await removeSaved(one.a.store, one.cloud, A), false);
  assert.equal((await one.a.data()).obligations.length, 1);
  // Replaced elsewhere.
  const two = await twoPhones();
  await two.cloud.deleteAll();
  const z = phone(two.cloud);
  await debt(z, await notebook(z), 3);
  await z.sync();
  assert.equal(await removeSaved(two.a.store, two.cloud, A), false);
  // Without a connection.
  const three = await twoPhones();
  three.cloud.offline = true;
  await assert.rejects(removeSaved(three.a.store, three.cloud, A), /cloud_offline/);
  assert.equal((await three.a.data()).obligations.length, 1);
  // An entry that arrives at the last moment stops it.
  const four = await twoPhones();
  const run = four.a.store.run.bind(four.a.store);
  let reads = 0;
  four.a.store.run = (async (mode: "readonly" | "readwrite", fn: never) => {
    if (mode === "readwrite" && reads++ === 0) await debt({ ...four.a, run: harness(Object.assign(Object.create(four.a.store), { run })).run } as Phone, four.n, 7);
    return run(mode, fn);
  }) as never;
  assert.equal(await removeSaved(four.a.store, four.cloud, A), false);
  four.a.store.run = run;
  assert.equal((await four.a.data()).obligations.length, 2);
  // All is there: new entries go first, then the phone is empty and the account has everything.
  const five = await twoPhones();
  await pay(five.a, five.n, 100);
  assert.equal(await removeSaved(five.a.store, five.cloud, A), true);
  assert.equal((await five.a.data()).workspaces.length, 0);
  assert.ok((await five.a.meta())!.cloudStop);
  assert.equal((await five.b.sync()).kind, "pulled");
  assert.equal(await owed(five.b, five.n), DA(900));
});

test("another account's notebook is removed only as far as this phone knows it is saved", async () => {
  const a = phone(new FakeCloud());
  const n = await notebook(a);
  await debt(a, n, 10);
  await a.sync();
  await pay(a, n, 1);
  assert.equal(await removeForeign(a.store), false);
  await a.sync();
  assert.equal(await removeForeign(a.store), true);
});

test("a person merged on one phone, a correction or an advance on the other: asked", async () => {
  for (const how of ["decrease", "advance", "installments"]) {
    const { a, b, n } = await twoPhones();
    const { partyId: twin } = await a.run("createParty", { workspaceId: n.workspaceId, displayName: "Doublon" });
    const d = { workspaceId: n.workspaceId, partyId: twin };
    const x = (await debt(a, d, 1000)) as R;
    const adv = how === "advance" ? ((await a.run("recordPayment", { ...d, direction: "receivable", currency: "DZD", amount: DA(400), date: "2026-11-02", allowAdvance: true, allocations: [] })) as R) : null;
    await a.sync();
    await b.sync();
    await a.run("mergeParties", { sourceId: twin, targetId: n.partyId, reason: "same" });
    if (how === "decrease") await b.run("adjustObligation", { obligationId: x.obligationId, type: "decrease", amount: DA(400), reason: "remise" });
    else if (adv) await b.run("applyAdvance", { paymentId: adv.paymentId });
    else await b.run("createInstallmentPlan", { obligationId: x.obligationId, frequency: "monthly", count: 4, startDate: "2026-12-01" });
    await a.sync();
    const s = (await b.sync()) as R;
    assert.deepEqual([how, s.kind, s.canCombine], [how, "choose", false]);
  }
});

test("a debt cancelled or replaced on one phone and changed on the other: asked", async () => {
  for (const how of ["netting", "increase", "installments"]) {
    const { a, b, n } = await twoPhones();
    const id = (await a.data()).obligations[0].id;
    await debt(a, n, 1000);
    await a.run("createObligation", { ...n, direction: "payable", currency: "DZD", principal: DA(1000), date: "2026-11-01" });
    await a.sync();
    await b.sync();
    if (how === "increase") await a.run("replaceObligation", { obligationId: id, changes: { principal: DA(1100) }, reason: "erreur" });
    else await a.run("voidObligation", { obligationId: id, reason: "erreur" });
    if (how === "netting") await b.run("netBalances", { ...n, currency: "DZD", amount: DA(1000), reason: "compensation" });
    else if (how === "increase") await b.run("adjustObligation", { obligationId: id, type: "increase", amount: DA(500), reason: "plus" });
    else await b.run("createInstallmentPlan", { obligationId: id, frequency: "monthly", count: 4, startDate: "2026-12-01" });
    await a.sync();
    const s = (await b.sync()) as R;
    assert.deepEqual([how, s.kind, s.canCombine], [how, "choose", false]);
  }
});

test("a plan ended on one phone and its next period made on the other: asked", async () => {
  const cloud = new FakeCloud();
  const a = phone(cloud);
  const n = await notebook(a);
  const { recurringPlanId } = await a.run("createRecurringPlan", { ...n, direction: "receivable", currency: "DZD", amount: DA(2000), description: "Loyer", frequency: "monthly", startDate: "2026-11-01" });
  await a.run("generateRecurring", { workspaceId: n.workspaceId });
  await a.sync();
  const b = phone(cloud);
  await b.sync();
  await a.run("updateRecurringPlan", { planId: recurringPlanId, action: "end" });
  await a.sync();
  await harness(b.store, () => new Date("2026-12-02T08:00:00Z")).run("generateRecurring", { workspaceId: n.workspaceId });
  assert.equal((await b.sync()).kind, "choose");
});

test("a shop's two phones that gave the same receipt number: asked, and both payments can be kept", async () => {
  const cloud = new FakeCloud();
  const a = phone(cloud);
  const { workspaceId } = await a.run("createWorkspace", { name: "Biz", mode: "business" });
  const { partyId } = await a.run("createParty", { workspaceId, displayName: "C" });
  const n = { workspaceId, partyId };
  await debt(a, n, 1000);
  await a.sync();
  const b = phone(cloud);
  await b.sync();
  await pay(a, n, 10);
  await pay(a, n, 5);
  await pay(b, n, 20);
  await a.sync();
  const s = (await b.sync()) as R;
  assert.deepEqual([s.kind, s.canCombine, s.people], ["choose", true, ["C"]]);
  assert.equal((await b.sync("combine")).kind, "combined");
  assert.equal(await owed(b, n), DA(965));
  // The next number is a new one, and the old double asks nothing any more.
  await a.sync();
  const { receiptNumber } = (await pay(a, n, 1)) as R;
  assert.equal((await a.data()).payments.filter((p) => p.receiptNumber === receiptNumber).length, 1);
  await b.run("addNote", { workspaceId, text: "y" });
  await a.sync();
  assert.equal((await b.sync()).kind, "combined");
  // The shop's settings changed differently on both is a disagreement.
  await a.sync();
  await a.run("updateWorkspace", { workspaceId, changes: { name: "Un" } });
  await b.run("updateWorkspace", { workspaceId, changes: { name: "Deux" } });
  await a.sync();
  assert.deepEqual([((await b.sync()) as R).kind, ((await b.sync()) as R).canCombine], ["choose", false]);
});

test("the shop's name changed on one phone and a receipt given on the other: both are kept", async () => {
  const cloud = new FakeCloud();
  const a = phone(cloud);
  const { workspaceId } = await a.run("createWorkspace", { name: "Biz", mode: "business" });
  const { partyId } = await a.run("createParty", { workspaceId, displayName: "C" });
  await debt(a, { workspaceId, partyId }, 1000);
  await a.sync();
  const b = phone(cloud);
  await b.sync();
  await a.run("updateWorkspace", { workspaceId, changes: { name: "Nouveau" } });
  await pay(b, { workspaceId, partyId }, 20);
  await a.sync();
  assert.equal((await b.sync()).kind, "combined");
  const ws = (await b.data()).workspaces[0];
  assert.deepEqual([ws.name, ws.settings.receipts.nextNumber], ["Nouveau", 2]);
});

test("the same imported line from two different files: asked", async () => {
  const { a, b, n } = await twoPhones();
  const batch = (id: string, hash: string) => ({
    workspaceId: n.workspaceId,
    source: "csv",
    fileName: "x.csv",
    fileHash: hash,
    records: {
      parties: [],
      obligations: [{ id, ...n, direction: "receivable", kind: "debt", currency: "DZD", principal: DA(700), date: "2026-11-03", description: "", reference: "", tags: [], state: "posted", attachmentIds: [], importFingerprint: "fp1", createdAt: "2026-11-03T00:00:00Z", createdBy: "i" }],
      payments: [],
      allocations: [],
    },
  });
  await a.run("commitImport", batch("csv_a_1", "ha"));
  await b.run("commitImport", batch("csv_b_1", "hb"));
  await a.sync();
  assert.equal((await b.sync()).kind, "choose");
});

test("what was already so on one phone does not block every later combination", async () => {
  const cloud = new FakeCloud();
  const a = phone(cloud);
  const { workspaceId } = await a.run("createWorkspace", { name: "Biz", mode: "business" });
  const { partyId } = await a.run("createParty", { workspaceId, displayName: "Karim" });
  const n = { workspaceId, partyId };
  await debt(a, n, 1000);
  // The same receipt number twice, from two phones that shared files before there were accounts.
  const other = phone(new FakeCloud());
  await other.meta();
  await restoreBackup(other.store, await createBackup(await a.data(), {}), { mode: "replace" });
  await pay(other, n, 5);
  await pay(a, n, 6);
  await restoreBackup(a.store, await createBackup(await other.data(), {}), { mode: "merge" });
  const numbers = (await a.data()).payments.map((p) => p.receiptNumber);
  assert.equal(new Set(numbers).size, 1, "the case this test is about");
  await a.sync();
  const b = phone(cloud);
  await b.sync();
  await a.run("addNote", { workspaceId, text: "x" });
  await b.run("addNote", { workspaceId, text: "y" });
  await a.sync();
  assert.equal((await b.sync()).kind, "combined");
  // A third one, made by combining, is still noticed.
  await a.sync();
  const third = { ...(await a.data()).payments[0], id: "pay_third", allowAdvance: true };
  await b.store.run("readwrite", (tx) => tx.put("payments", third));
  await a.run("addNote", { workspaceId, text: "z" });
  await a.sync();
  assert.equal((await b.sync()).kind, "combined", "b already had the three by itself");
});

test("a copy that no phone could open is not sent", async () => {
  const { cloud, a, n } = await twoPhones();
  const id = (await a.data()).obligations[0].id;
  await a.store.run("readwrite", async (tx) => tx.put("adjustments", { id: "adj_bad", ...n, obligationId: id, type: "decrease", amount: DA(5000), date: "2026-11-02", reason: "x", createdAt: "2026-11-02T00:00:00Z", createdBy: "x" }));
  assert.ok(validateLedger(await a.data()).length, "the case this test is about");
  await assert.rejects(a.sync(), /cloud_invalid/);
  assert.equal(cloud.saves, 1);
});

test("a damaged current copy: a new phone can take an older one, a phone in use can save its own again", async () => {
  const { cloud, a, b, n } = await twoPhones();
  const first = cloud.h!.versionId;
  await pay(a, n, 100);
  await a.sync();
  const bad = cloud.h!.versionId;
  cloud.blobs.set(bad, new Uint8Array([1, 2]));
  const fresh = phone(cloud);
  await assert.rejects(fresh.sync(), /cloud_corrupt/);
  assert.equal((await restoreVersion(fresh.store, cloud, A, first)).kind, "saved");
  assert.equal(await owed(fresh, n), DA(1000));
  assert.ok(cloud.h!.versions.some((v) => v.id === bad && v.pinned), "kept, in case it can be read one day");
  // A phone in use.
  cloud.blobs.set(cloud.h!.versionId, new Uint8Array([1, 2]));
  await pay(b, n, 1);
  const s = (await b.sync()) as R;
  assert.deepEqual([s.kind, s.reason, s.canCombine], ["choose", "cloud_unreadable", false]);
  assert.equal((await b.sync("keep_phone")).kind, "saved");
  assert.equal((await phone(cloud).sync()).kind, "pulled");
});

test("a copy that vanished because another phone saved meanwhile is not called damaged", async () => {
  const { cloud, a, b, n } = await twoPhones();
  await pay(a, n, 10);
  await a.sync();
  const read = cloud.read.bind(cloud);
  cloud.read = async () => {
    cloud.read = read;
    await pay(a, n, 10);
    await a.sync();
    throw new CloudError("cloud_corrupt");
  };
  assert.equal((await b.sync()).kind, "again");
  assert.equal((await b.sync()).kind, "pulled");
  assert.equal(await owed(b, n), DA(980));
});

test("photos are kept on the phone when another phone's choice takes their notebook away", async () => {
  const { cloud, a, b } = await twoPhones();
  const first = cloud.h!.versionId;
  const w = await notebook(a, "Second");
  const o = (await debt(a, w, 50)) as R;
  await a.run("addAttachment", { workspaceId: w.workspaceId, ownerType: "obligation", ownerId: o.obligationId, name: "recu.png", mime: "image/png", data: "aGVsbG8=", sha256: "x" });
  await a.sync();
  await b.sync();
  await restoreVersion(b.store, cloud, A, first);
  assert.equal((await snapshots(a)).length, 0);
  assert.equal((await a.sync()).kind, "pulled");
  assert.equal((await a.data()).attachments.length, 0);
  const kept = await snapshots(a);
  assert.equal(kept.length, 1);
  assert.match(kept[0].backup, /recu\.png/);
  // It does not give way to the snapshots of later combinations.
  for (let i = 0; i < 4; i++) {
    await pay(b, { workspaceId: (await b.data()).workspaces[0].id, partyId: (await b.data()).parties[0].id }, 1);
    await b.sync();
    await pay(a, { workspaceId: (await a.data()).workspaces[0].id, partyId: (await a.data()).parties[0].id }, 1);
    await new Promise((r) => setTimeout(r, 3));
    assert.equal((await a.sync()).kind, "combined");
    await b.sync();
  }
  assert.ok((await snapshots(a)).some((s) => /recu\.png/.test(s.backup)));
});

test("a choice is not applied to another situation than the one shown", async () => {
  const { cloud, a, b, n } = await twoPhones();
  await cloud.deleteAll();
  await debt(a, n, 11);
  await debt(b, n, 22);
  assert.equal(((await a.sync()) as R).reason, "cloud_deleted");
  assert.equal(((await b.sync()) as R).reason, "cloud_deleted");
  assert.equal((await a.sync("keep_phone")).kind, "saved");
  // The same button on the other phone, pressed later: the cloud is not deleted any more.
  const s = (await b.sync("keep_phone")) as R;
  assert.deepEqual([s.kind, s.reason], ["choose", "cloud_replaced"]);
  assert.equal(cloud.saves, 2);
  assert.equal((await b.sync("combine")).kind, "combined");
  await a.sync();
  assert.equal(await owed(a, n), DA(1033));
});

test("the state before going back to an older copy stays, whatever follows", async () => {
  const { cloud, a, n } = await twoPhones();
  const first = cloud.h!.versionId;
  await pay(a, n, 400);
  await a.sync();
  const present = cloud.h!.versionId;
  await restoreVersion(a.store, cloud, A, first);
  for (let i = 0; i < 6; i++) {
    await debt(a, n, 1 + i);
    await a.sync();
  }
  assert.ok(cloud.h!.versions.some((v) => v.id === present && v.pinned));
});

test("the state before an older copy stays also when sending it failed, or another phone saved between", async () => {
  for (const how of ["offline", "moved"]) {
    const { cloud, a, b, n } = await twoPhones();
    const first = cloud.h!.versionId;
    await pay(a, n, 400);
    await a.sync();
    await b.sync();
    const present = cloud.h!.versionId;
    const save = cloud.save.bind(cloud);
    cloud.save = async () => {
      cloud.save = save;
      if (how === "offline") throw new CloudError("cloud_offline");
      await debt(b, n, 33);
      await b.sync();
      throw new CloudError("cloud_moved");
    };
    await assert.rejects(restoreVersion(a.store, cloud, A, first));
    assert.match((await a.sync()).kind, /saved|combined/);
    assert.equal((await a.meta())!.cloud!.pin, undefined);
    for (let i = 0; i < 6; i++) {
      await debt(a, n, 1 + i);
      await a.sync();
    }
    assert.ok(cloud.h!.versions.some((v) => v.id === present && v.pinned), how);
    assert.equal(cloud.h!.versions.filter((v) => v.pinned).length, 1);
  }
});

test("a debt added to a person archived on the other phone: asked, and both can be kept", async () => {
  const { a, b, n } = await twoPhones();
  await pay(a, n, 1000);
  await a.sync();
  await b.sync();
  await a.run("archiveParty", { partyId: n.partyId, archived: true });
  await debt(b, n, 500);
  await a.sync();
  const s = (await b.sync()) as R;
  assert.deepEqual([s.kind, s.canCombine], ["choose", true]);
});

test("a correction taken back on one phone, its debt replaced on the other: asked", async () => {
  const { a, b, n } = await twoPhones();
  const id = (await a.data()).obligations[0].id;
  const { adjustmentId } = await a.run("adjustObligation", { obligationId: id, type: "waiver", amount: DA(300), reason: "w" });
  await a.sync();
  await b.sync();
  await a.run("replaceObligation", { obligationId: id, changes: { principal: DA(700) }, reason: "x" });
  await b.run("reverseAdjustment", { adjustmentId, reason: "r" });
  await a.sync();
  const s = (await b.sync()) as R;
  assert.deepEqual([s.kind, s.canCombine], ["choose", false]);
  void n;
});

test("an inconsistent notebook can still give way to the account's copy or to an older one", async () => {
  const spoil = async (p: Phone, n: { workspaceId: string; partyId: string }) => {
    const id = (await p.data()).obligations[0].id;
    await p.store.run("readwrite", async (tx) => tx.put("adjustments", { id: "adj_bad", ...n, obligationId: id, type: "decrease", amount: DA(5000), date: "2026-11-02", reason: "x", createdAt: "2026-11-02T00:00:00Z", createdBy: "x" }));
  };
  const one = await twoPhones();
  await spoil(one.a, one.n);
  await pay(one.b, one.n, 1);
  await one.b.sync();
  assert.equal((await one.a.sync()).kind, "choose");
  assert.equal((await one.a.sync("keep_cloud")).kind, "pulled");
  assert.deepEqual(validateLedger(await one.a.data()), []);
  const two = await twoPhones();
  await spoil(two.a, two.n);
  assert.equal((await restoreVersion(two.a.store, two.cloud, A, two.cloud.h!.versionId)).kind, "up_to_date");
  assert.deepEqual(validateLedger(await two.a.data()), []);
  assert.ok((await snapshots(two.a)).some((s) => /adj_bad/.test(s.backup)), "kept on the phone");
});

test("an empty phone never replaces a copy, even one with only notes or an empty notebook", async () => {
  const cloud = new FakeCloud();
  const a = phone(cloud);
  const { workspaceId } = await a.run("createWorkspace", { name: "N" });
  await a.run("addNote", { workspaceId, text: "Ali 500" });
  await a.sync();
  await a.store.run("readwrite", async (tx) => {
    await tx.clear("notes");
    await tx.clear("workspaces");
  });
  assert.equal((await a.sync()).kind, "pulled");
  assert.equal((await a.data()).notes.length, 1);
});

test("a late phone clock does not age the new copy; a clock set back does not drop the new snapshot", async () => {
  const { cloud, a, n } = await twoPhones();
  await pay(a, n, 1);
  await syncOnce(a.store, cloud, { ...A, now: () => new Date("2026-11-01T00:00:00Z") });
  assert.ok(cloud.h!.versions.find((v) => v.id === cloud.h!.versionId)!.at >= "2026-11-22");
  const t = await twoPhones();
  for (let i = 0; i < 5; i++) {
    await pay(t.a, t.n, 1);
    await t.a.sync();
    await pay(t.b, t.n, 1);
    const now = new Date(Date.UTC(2026, 10, 25 - i));
    assert.equal((await syncOnce(t.b.store, t.cloud, { ...A, now: () => now })).kind, "combined");
    const ids = (await snapshots(t.b)).map((s) => s.id);
    assert.ok(ids.includes("snap_" + now.getTime()));
    assert.ok(ids.length <= 3);
    await t.a.sync();
  }
});

test("somebody looking at the demo stays there when a copy arrives", async () => {
  const { a, b, n } = await twoPhones();
  const { workspaceId } = await b.run("createWorkspace", { name: "Demo", demo: true });
  await b.store.run("readwrite", async (tx) => tx.put("meta", { ...(await tx.get("meta", "app"))!, activeWorkspaceId: workspaceId }));
  await pay(a, n, 1);
  await a.sync();
  assert.equal((await b.sync()).kind, "pulled");
  assert.equal((await b.meta())!.activeWorkspaceId, workspaceId);
});

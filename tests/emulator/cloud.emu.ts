// The real Firebase code and the real security rules, on the emulators (npm run test:cloud).
// The project is "demo-nsalek": the emulators never reach a real project with that prefix.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, createUserWithEmailAndPassword, inMemoryPersistence, initializeAuth } from "firebase/auth";
import { Bytes, collection, connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, getFirestore, serverTimestamp, setDoc, updateDoc, writeBatch, type Firestore } from "firebase/firestore/lite";
import { FirebaseCloud, type CloudConfig } from "../../lib/cloud/firebase.ts";
import { syncOnce, restoreVersion, type Choice } from "../../lib/cloud/sync.ts";
import { pack } from "../../lib/cloud/bundle.ts";
import { PART_BYTES, type CloudPort } from "../../lib/cloud/port.ts";
import { MemoryStore } from "../../lib/core/store.ts";
import { partyBalance } from "../../lib/core/ledger.ts";
import { DA, harness, loadAll, TODAY, type R } from "../helpers.ts";

const config: CloudConfig = { apiKey: "demo", authDomain: "demo-nsalek.firebaseapp.com", projectId: "demo-nsalek", appId: "demo", emulator: { host: "127.0.0.1", auth: 9299, firestore: 8285 } };
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run with: npm run test:cloud");

const PASS = "mot-de-passe-2026";
let n = 0;
const mail = () => `p${Date.now()}${++n}@example.com`;
const open: FirebaseCloud[] = [];
const client = () => {
  const c = new FirebaseCloud(config, { name: "t" + ++n, memory: true });
  open.push(c);
  return c;
};
after(() => Promise.all(open.map((c) => c.close().catch(() => undefined))));
const pause = (ms = 2200) => new Promise((r) => setTimeout(r, ms));

async function person() {
  const cloud = client();
  const email = mail();
  const account = await cloud.signUp(email, PASS);
  return { cloud, email, account, uid: account.uid, port: cloud.port(account.uid) };
}
type Person = Awaited<ReturnType<typeof person>>;

function phone(p: { uid: string; email: string; port: CloudPort }) {
  const store = new MemoryStore();
  const h = harness(store);
  const ready = store.run("readwrite", (tx) => tx.put("meta", { id: "app", schemaVersion: 1, deviceId: "d", activeWorkspaceId: null }));
  const who = { uid: p.uid, email: p.email, device: "test" };
  return { ...h, who, sync: async (choice?: Choice) => (await ready, syncOnce(store, p.port, { ...who, choice })) };
}
type Phone = ReturnType<typeof phone>;
async function notebook(p: Phone) {
  const { workspaceId } = await p.run("createWorkspace", { name: "Carnet" });
  const { partyId } = await p.run("createParty", { workspaceId, displayName: "كريم" });
  await p.run("createObligation", { workspaceId, partyId, direction: "receivable", currency: "DZD", principal: DA(1000), date: "2026-11-01" });
  return { workspaceId, partyId };
}
const pay = (p: Phone, k: { workspaceId: string; partyId: string }, amount: number) => p.run("recordPayment", { ...k, direction: "receivable", currency: "DZD", amount: DA(amount), date: "2026-11-02" });
const owed = async (p: Phone, k: { workspaceId: string; partyId: string }) => partyBalance(await p.index(k.workspaceId), k.partyId, TODAY).get("DZD")?.receivable ?? 0;

/** A raw connection, as someone who writes their own program would have. */
async function raw(): Promise<{ db: Firestore; uid: string; app: FirebaseApp }> {
  const app = initializeApp({ apiKey: "demo", projectId: "demo-nsalek" }, "raw" + ++n);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, "http://127.0.0.1:9299", { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8285);
  const { user } = await createUserWithEmailAndPassword(auth, mail(), PASS);
  return { db, uid: user.uid, app };
}
const denied = (p: Promise<unknown>, what: string) => assert.rejects(p, (e: R) => /permission-denied/.test(e.code), what);
const version = (id: string, rev = 1) => ({ id, rev, at: "2026-11-25T10:00:00Z", device: "x", bytes: 3, parts: 1, encoding: "none", sha: "s", schemaVersion: 1, people: 0, entries: 0 });
const head = (id: string, rev = 1, lineage = "L") => ({ lineage, rev, versionId: id, versions: [version(id, rev)], added: id, updatedAt: serverTimestamp() });
const part = (id: string, k = 0, data = new Uint8Array([1, 2, 3])) => ({ v: id, n: k, data: Bytes.fromUint8Array(data) });

let a: Person;
before(async () => {
  a = await person();
});

// ---------------------------------------------------------------- the whole way

test("sign up, save, sign in on another phone: everything comes back", async () => {
  const one = phone(a);
  const k = await notebook(one);
  assert.equal((await one.sync()).kind, "saved");
  const c2 = client();
  const again = await c2.signIn(a.email.toUpperCase(), PASS);
  assert.equal(again.uid, a.uid);
  const two = phone({ uid: again.uid, email: again.email, port: c2.port(again.uid) });
  assert.equal((await two.sync()).kind, "pulled");
  assert.equal(await owed(two, k), DA(1000));
  // The two phones work apart, then meet.
  await pay(one, k, 100);
  await pay(two, k, 200);
  await pause();
  assert.equal((await one.sync()).kind, "saved");
  await pause();
  assert.equal((await two.sync()).kind, "combined");
  assert.equal((await one.sync()).kind, "pulled");
  assert.equal(await owed(one, k), DA(700));
  // An older copy is put back: two saves in a row, which the pace rule makes wait.
  const h = (await a.port.head())!;
  const first = h.versions.find((v) => v.rev === 1)!;
  await pay(one, k, 1);
  await restoreVersion(one.store, a.port, one.who, first.id);
  assert.equal(await owed(one, k), DA(1000));
  assert.equal((await two.sync()).kind, "pulled");
  assert.equal(await owed(two, k), DA(1000));
});

test("two saves at the same moment: exactly one is kept, the other is told", async () => {
  const p = await person();
  const one = phone(p);
  const k = await notebook(one);
  await one.sync();
  const two = phone(p);
  await two.sync();
  await pay(one, k, 10);
  await pay(two, k, 20);
  await pause();
  const r = await Promise.allSettled([one.sync(), two.sync()]);
  const bad = r.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
  assert.equal(bad.length, 1);
  assert.match(String(bad[0].reason.code), /cloud_moved/);
  assert.equal((await p.port.head())!.rev, 2);
  await pause();
  await one.sync();
  await pause();
  await two.sync();
  await one.sync();
  assert.equal(await owed(one, k), DA(970));
  assert.equal(await owed(two, k), DA(970));
});

test("a copy of several pieces is kept and read whole; kept copies are the only ones stored", async () => {
  const p = await person();
  const bytes = new Uint8Array(PART_BYTES * 2 + 1234).map((_, i) => (i * 7919) % 251);
  const v = { ...version("big"), bytes: bytes.length, parts: 3, encoding: "none" as const };
  await p.port.save({ after: null, head: { lineage: "L", rev: 1, versionId: "big", versions: [v] }, add: { version: v, bytes }, drop: [] });
  assert.deepEqual(await p.port.read(v), bytes);
  await pause();
  const w = { ...version("small", 2), encoding: "none" as const };
  await p.port.save({ after: { lineage: "L", rev: 1 }, head: { lineage: "L", rev: 2, versionId: "small", versions: [w] }, add: { version: w, bytes: new Uint8Array([1, 2, 3]) }, drop: [v] });
  await assert.rejects(p.port.read(v), /cloud_corrupt/);
  assert.deepEqual([...(await p.port.read(w))], [1, 2, 3]);
});

test("the biggest allowed copy fits in one save", async () => {
  const p = await person();
  const bytes = crypto.getRandomValues(new Uint8Array(65_536));
  const big = new Uint8Array(8_500_000).map((_, i) => bytes[i % 65_536]);
  const v = { ...version("max"), bytes: big.length, parts: Math.ceil(big.length / PART_BYTES), encoding: "none" as const };
  await p.port.save({ after: null, head: { lineage: "L", rev: 1, versionId: "max", versions: [v] }, add: { version: v, bytes: big }, drop: [] });
  assert.equal((await p.port.read(v)).length, big.length);
});

test("an account that never saved can be deleted, and a deletion cut in the middle can be finished", async () => {
  const p = await person();
  await p.port.deleteAll();
  await p.cloud.confirm(PASS);
  await p.cloud.deleteAccount();
  const r = await raw();
  const b = writeBatch(r.db);
  b.set(doc(r.db, "users", r.uid), head("v1"));
  b.set(doc(r.db, "users", r.uid, "parts", "v1-0"), part("v1"));
  await b.commit();
  await pause();
  await deleteDoc(doc(r.db, "users", r.uid)); // the connection is lost here
  await deleteDoc(doc(r.db, "users", r.uid)); // and the deletion is begun again
  await deleteDoc(doc(r.db, "users", r.uid, "parts", "v1-0"));
  assert.equal((await getDocs(collection(r.db, "users", r.uid, "parts"))).size, 0);
});

test("deleting the account removes the copy, all pieces and the sign-in", async () => {
  const p = await person();
  const one = phone(p);
  await notebook(one);
  await one.sync();
  await p.cloud.confirm(PASS);
  await p.port.deleteAll();
  assert.equal(await p.port.head(), null);
  await p.cloud.deleteAccount();
  await assert.rejects(client().signIn(p.email, PASS), /auth_wrong/);
});

// ---------------------------------------------------------------- forgetting and mistakes

test("forgotten password: the emailed code sets a new one, and the notebook is still there", async () => {
  const p = await person();
  const one = phone(p);
  const k = await notebook(one);
  await one.sync();
  const c = client();
  await c.resetPassword(p.email);
  const sent = (await (await fetch("http://127.0.0.1:9299/emulator/v1/projects/demo-nsalek/oobCodes")).json()) as R;
  const code = sent.oobCodes.filter((x: R) => x.email === p.email && x.requestType === "PASSWORD_RESET").at(-1);
  const done = await fetch(`http://127.0.0.1:9299/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oobCode: code.oobCode, newPassword: "nouveau-mot-2026" }) });
  assert.equal(done.status, 200);
  await assert.rejects(client().signIn(p.email, PASS), /auth_wrong/);
  const c2 = client();
  const acc = await c2.signIn(p.email, "nouveau-mot-2026");
  const two = phone({ uid: acc.uid, email: acc.email, port: c2.port(acc.uid) });
  assert.equal((await two.sync()).kind, "pulled");
  assert.equal(await owed(two, k), DA(1000));
});

test("a Google address can be taken off the account, and is named while it is on it", async () => {
  const p = await person();
  const idp = (email: string) =>
    fetch("http://127.0.0.1:9299/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token, requestUri: "http://localhost", returnSecureToken: true, postBody: "providerId=google.com&id_token=" + encodeURIComponent(JSON.stringify({ sub: "g" + email, email, email_verified: true })) }),
    });
  const signed = (await (await fetch("http://127.0.0.1:9299/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: p.email, password: PASS, returnSecureToken: true }) })).json()) as R;
  const token = signed.idToken as string;
  assert.equal((await idp("someone.else@example.com")).status, 200);
  let acc = await p.cloud.refresh();
  assert.deepEqual([acc.google, acc.googleEmail, acc.password], [true, "someone.else@example.com", true]);
  acc = await p.cloud.unlinkGoogle();
  assert.deepEqual([acc.google, acc.googleEmail, acc.password], [false, "", true]);
});

test("sign-in mistakes give a clear reason and never say whether an address exists", async () => {
  const p = await person();
  await assert.rejects(client().signIn(p.email, "wrong-password"), /auth_wrong/);
  await assert.rejects(client().signIn(mail(), PASS), /auth_wrong/);
  await assert.rejects(client().signUp(p.email, PASS), /auth_taken/);
  await assert.rejects(client().signUp(mail(), "123"), /auth_weak/);
  await assert.rejects(client().signUp("not an address", PASS), /auth_email/);
  await client().resetPassword(mail()); // unknown address: no error
});

// ---------------------------------------------------------------- the rules

test("nobody reaches another person's copy, and nobody lists people", async () => {
  const one = phone(a);
  const v = (await a.port.head())!.versions[0];
  const b = await raw();
  const visitorApp = initializeApp({ apiKey: "demo", projectId: "demo-nsalek" }, "visitor");
  const visitor = getFirestore(visitorApp);
  connectFirestoreEmulator(visitor, "127.0.0.1", 8285);
  for (const [db, who] of [[b.db, "another account"], [visitor, "no account"]] as const) {
    await denied(getDoc(doc(db, "users", a.uid)), who + " reads the head");
    await denied(getDoc(doc(db, "users", a.uid, "parts", v.id + "-0")), who + " reads a piece");
    await denied(getDocs(collection(db, "users", a.uid, "parts")), who + " lists pieces");
    await denied(getDocs(collection(db, "users")), who + " lists people");
    await denied(setDoc(doc(db, "users", a.uid), head("evil")), who + " writes the head");
    await denied(deleteDoc(doc(db, "users", a.uid)), who + " deletes the head");
    await denied(deleteDoc(doc(db, "users", a.uid, "parts", v.id + "-0")), who + " deletes a piece");
    await denied(setDoc(doc(db, "users", a.uid, "parts", "evil-0"), part("evil")), who + " adds a piece");
    await denied(setDoc(doc(db, "other", "x"), { a: 1 }), who + " writes elsewhere");
    await denied(getDoc(doc(db, "clinics", "agrovet")), who + " reads elsewhere");
  }
  await denied(getDocs(collection(b.db, "users")), "even their own list");
  const mine = new FirebaseCloud(config, { name: "stranger", memory: true });
  await assert.rejects(mine.port(a.uid).head(), /cloud_denied/);
  await mine.close();
  assert.ok(one);
});

test("own copy: stale, skipped, hurried, shrunken or odd saves are refused", async () => {
  const { db, uid } = await raw();
  const ref = doc(db, "users", uid);
  const save = (h: R, parts: [string, R][] = []) => {
    const b = writeBatch(db);
    b.set(ref, h);
    for (const [id, p] of parts) b.set(doc(db, "users", uid, "parts", id), p);
    return b.commit();
  };
  await denied(save(head("v", 2)), "first save that is not number 1");
  await denied(save({ ...head("v"), extra: 1 }), "extra field");
  await denied(save({ ...head("v"), updatedAt: new Date() }), "own clock");
  await denied(save({ ...head("v"), versions: [] }), "no version");
  await denied(save({ ...head("v"), versions: Array.from({ length: 61 }, (_, i) => version("v" + i)) }), "too many versions");
  await denied(save({ ...head("v"), versionId: "x".repeat(65) }), "long id");
  await denied(save({ ...head("v"), added: 1 }), "an added copy that is not named");
  await denied(save(head("v1"), [["v1-0", part("v1")], ["v2-0", part("v2")]]), "pieces of a copy that is not the added one");
  await save(head("v1"), [["v1-0", part("v1")]]);
  await denied(save(head("v2", 2), [["v2-0", part("v2")]]), "hurried: less than two seconds later");
  await denied(deleteDoc(ref), "removed and made anew in a rush");
  await pause();
  await denied(save(head("v2", 1)), "same number");
  await denied(save(head("v2", 3)), "skipped number");
  await denied(save(head("v2", 2, "other")), "another lineage");
  await denied(updateDoc(ref, { versionId: "zzz" }), "a change that is not a save");
  await denied(setDoc(doc(db, "users", uid, "parts", "free-0"), part("free")), "a piece without a save");
  await denied(save(head("v2", 2), [["v2-0", part("v2", 0, new Uint8Array(900_001))]]), "a piece too big");
  await denied(save(head("v2", 2), [["v2-10", part("v2", 10)]]), "an eleventh piece");
  await denied(save(head("v2", 2), [["wrong-0", part("v2")]]), "a piece under another name");
  await denied(save(head("v2", 2), [["v2-0", { ...part("v2"), more: 1 }]]), "a piece with more in it");
  await denied(setDoc(doc(db, "users", uid, "parts", "v1-0"), part("v1")), "a piece rewritten");
  await denied(deleteDoc(doc(db, "users", uid, "parts", "v1-0")), "the current copy's piece removed");
  await save(head("v2", 2), [["v2-0", part("v2")]]);
  await denied(setDoc(doc(db, "users", uid, "parts", "v2-1"), part("v2", 1)), "one more piece of the copy added before");
  await deleteDoc(doc(db, "users", uid, "parts", "v1-0"));
  await denied(deleteDoc(doc(db, "users", uid, "parts", "v2-0")), "the current copy's piece removed");
  // The whole copy may be removed, in order.
  await pause();
  await deleteDoc(ref);
  await deleteDoc(doc(db, "users", uid, "parts", "v2-0"));
});

test("a year of a shop is sent in one piece", async () => {
  const p = await person();
  const one = phone(p);
  const k = await notebook(one);
  for (let i = 0; i < 400; i++) await one.run("createObligation", { ...k, direction: "receivable", currency: "DZD", principal: 1000 + i, date: "2026-11-01", description: "Courses " + i });
  const size = (await pack(await loadAll(one.store), { now: new Date() })).bytes.length;
  assert.ok(size < PART_BYTES, String(size));
  assert.equal((await one.sync()).kind, "saved");
});

test("a phone hears within seconds that another phone saved, and not its own save", async () => {
  const p = await person();
  const a = phone(p);
  const n = await notebook(a);
  await a.sync();
  // The second phone: the same account signed in on another device.
  const other = client();
  await other.signIn(p.email, PASS);
  const heard: (string | null)[] = [];
  const stop = await other.watchHead((v) => heard.push(v));
  await pause(1500);
  const first = heard.length;
  assert.ok(first >= 1, "the current version arrives when listening starts");
  await pay(a, n, 10);
  await a.sync();
  const start = Date.now();
  while (heard.length === first && Date.now() - start < 8000) await pause(200);
  assert.ok(heard.length > first, "the new save is heard");
  assert.notEqual(heard.at(-1), heard[first - 1], "with its new version");
  stop();
});

// Regression tests for the issues found in the 2026-11-23 feature-by-feature test
// (docs/test-report-2026-11-23.md). Each test names the issue it guards.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promiseState } from "../lib/core/collections.ts";
import { advancePayments, figuresOf, obligationStatus, partyEffects, receiptFigures } from "../lib/core/ledger.ts";
import { periodReport } from "../lib/core/reports.ts";
import { createBackup, serializeBackup } from "../lib/core/backup.ts";
import { pinDelayMs } from "../lib/core/pin.ts";
import { DATA_STORES } from "../lib/core/types.ts";
import { auditActionLabel, channelLabel, importErrorMessage, peopleCount, snapshotLabel, storeLabel, translate } from "../lib/ui/i18n.ts";
import { renderServiceWorker } from "../scripts/sw-precache.mjs";
import { basic, DA, NOW, TODAY, loadAll } from "./helpers.ts";

/** A clock that moves one second per call, so records made in sequence have distinct times. */
const ticking = () => {
  let t = NOW.getTime();
  return () => new Date((t += 1000));
};
type H = { workspaceId: string; partyId: string };
const rec = (h: H, amount: number, extra: Record<string, unknown> = {}) => ({ workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", principal: DA(amount), date: "2026-11-21", ...extra });
const pay = (h: H, amount: number, extra: Record<string, unknown> = {}) => ({ workspaceId: h.workspaceId, partyId: h.partyId, direction: "receivable", currency: "DZD", amount: DA(amount), date: TODAY, ...extra });

test("H4: a promise is not kept by a payment recorded before it, even on the same day", async () => {
  const h = await basic(undefined, ticking());
  await h.run("createObligation", rec(h, 3000));
  await h.run("recordPayment", pay(h, 2000));
  await h.run("createPromise", { workspaceId: h.workspaceId, partyId: h.partyId, currency: "DZD", amount: DA(1000), promisedDate: "2026-11-29" });
  let idx = await h.index(h.workspaceId);
  const promise = idx.promisesByParty.get(h.partyId)![0];
  assert.equal(promiseState(promise, idx, TODAY).state, "pending");
  await h.run("recordPayment", pay(h, 1000));
  idx = await h.index(h.workspaceId);
  assert.equal(promiseState(promise, idx, TODAY).state, "kept");
});

test("H3: a receipt shows the figures at the time of payment, not today's", async () => {
  const h = await basic(undefined, ticking());
  const older = await h.run("createObligation", rec(h, 2500, { date: "2026-11-10", dueDate: "2026-11-20" }));
  const newer = await h.run("createObligation", rec(h, 7500));
  const p1 = await h.run("recordPayment", pay(h, 4000));
  const p2 = await h.run("recordPayment", pay(h, 9000, { allowAdvance: true }));
  // Later events must not change either receipt.
  await h.run("reversePayment", { paymentId: p1.paymentId, reason: "cheque bounced" });
  await h.run("createObligation", rec(h, 2000));
  const idx = await h.index(h.workspaceId);

  const r1 = receiptFigures(idx, idx.payment.get(p1.paymentId)!);
  assert.deepEqual(
    r1.lines.map((l) => [l.obligationId, l.amount, l.remainingAfter]),
    [
      [older.obligationId, DA(2500), 0],
      [newer.obligationId, DA(1500), DA(6000)],
    ],
  );
  assert.equal(r1.remainingAfter, DA(6000));
  assert.equal(r1.advance, 0);

  const r2 = receiptFigures(idx, idx.payment.get(p2.paymentId)!);
  assert.equal(r2.remainingAfter, 0);
  assert.equal(r2.advance, DA(3000));
});

test("M3: payments that still carry an unused advance are listed, oldest first", async () => {
  const h = await basic(undefined, ticking());
  await h.run("createObligation", rec(h, 6000));
  const p = await h.run("recordPayment", pay(h, 9000, { allowAdvance: true }));
  let idx = await h.index(h.workspaceId);
  assert.deepEqual(
    advancePayments(idx, h.partyId, "receivable", "DZD").map((x) => [x.payment.id, x.unallocated]),
    [[p.paymentId, DA(3000)]],
  );
  assert.deepEqual(advancePayments(idx, h.partyId, "payable", "DZD"), []);
  const debt = await h.run("createObligation", rec(h, 3000));
  await h.run("applyAdvance", { paymentId: p.paymentId, allocations: [{ obligationId: debt.obligationId, amount: DA(3000) }] });
  idx = await h.index(h.workspaceId);
  assert.deepEqual(advancePayments(idx, h.partyId, "receivable", "DZD"), []);
});

test("M3: an advance applied later the same day is its own history entry, after the debt it settles", async () => {
  const h = await basic(undefined, ticking());
  await h.run("createObligation", rec(h, 6000));
  const p = await h.run("recordPayment", pay(h, 9000, { allowAdvance: true }));
  const debt = await h.run("createObligation", rec(h, 2000, { date: TODAY }));
  await h.run("applyAdvance", { paymentId: p.paymentId, allocations: [{ obligationId: debt.obligationId, amount: DA(2000) }] });
  const idx = await h.index(h.workspaceId);
  const effects = partyEffects(idx, h.partyId);
  assert.deepEqual(
    effects.filter((e) => e.paymentId === p.paymentId).map((e) => [e.kind, e.delta]),
    [
      ["payment", -DA(6000)],
      ["advance_applied", -DA(2000)],
    ],
  );
  const kinds = effects.map((e) => e.kind);
  assert.ok(kinds.indexOf("advance_applied") > kinds.lastIndexOf("obligation"), "the advance comes after the debt it settles");
});

test("M5: a debt reduced only by a discount is open, not partly paid", async () => {
  const h = await basic();
  const { obligationId } = await h.run("createObligation", rec(h, 2500));
  await h.run("adjustObligation", { obligationId, type: "waiver", amount: DA(500), reason: "loyal customer" });
  const idx = await h.index(h.workspaceId);
  const ob = idx.obligation.get(obligationId)!;
  assert.equal(figuresOf(idx, ob).outstanding, DA(2000));
  assert.equal(obligationStatus(ob, figuresOf(idx, ob)), "open");
});

test("M4: explicit netting never reduces a disputed debt", async () => {
  const h = await basic();
  const disputed = await h.run("createObligation", rec(h, 1800, { date: "2026-11-10" }));
  await h.run("setDispute", { obligationId: disputed.obligationId, disputed: true, note: "client disagrees" });
  const clean = await h.run("createObligation", rec(h, 1500));
  await h.run("createObligation", { ...rec(h, 2000), direction: "payable" });
  await assert.rejects(h.run("netBalances", { workspaceId: h.workspaceId, partyId: h.partyId, currency: "DZD", amount: DA(1600), reason: "agreement" }), /netting_exceeds/);
  await h.run("netBalances", { workspaceId: h.workspaceId, partyId: h.partyId, currency: "DZD", amount: DA(1000), reason: "agreement" });
  const idx = await h.index(h.workspaceId);
  assert.equal(figuresOf(idx, idx.obligation.get(disputed.obligationId)!).netted, 0);
  assert.equal(figuresOf(idx, idx.obligation.get(clean.obligationId)!).netted, DA(1000));
});

test("M6: the period report counts an explicit netting once", async () => {
  const h = await basic();
  await h.run("createObligation", rec(h, 1500));
  await h.run("createObligation", { ...rec(h, 1000), direction: "payable" });
  await h.run("netBalances", { workspaceId: h.workspaceId, partyId: h.partyId, currency: "DZD", amount: DA(1000), reason: "agreement" });
  const idx = await h.index(h.workspaceId);
  assert.equal(periodReport(idx, "2026-11-01", TODAY).get("DZD")!.netted, DA(1000));
});

test("M1: an encrypted backup does not reveal totals before the passphrase", async () => {
  const h = await basic();
  await h.run("createObligation", rec(h, 12345));
  const file = await createBackup(await loadAll(h.store), { passphrase: "correct horse", iterations: 1000 });
  assert.deepEqual(file.manifest.totals, []);
  assert.ok(!serializeBackup(file).includes(String(DA(12345))), "no amount in the clear");
  const plain = await createBackup(await loadAll(h.store));
  assert.equal(plain.manifest.totals[0].receivable, DA(12345), "unencrypted backups keep their totals");
});

test("H1: the offline worker pre-caches every file of the built app", () => {
  const out = mkdtempSync(join(tmpdir(), "nsalek-out-"));
  try {
    mkdirSync(join(out, "_next/static/chunks"), { recursive: true });
    mkdirSync(join(out, "_next/static/media"), { recursive: true });
    for (const f of ["index.html", "sample-statement.html", "manifest.webmanifest", "icon.svg", "icon-192.png", "_next/static/chunks/app.js", "_next/static/chunks/app.css", "_next/static/media/font.woff2"]) writeFileSync(join(out, f), f);
    const template = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
    const sw = renderServiceWorker(template, out);
    for (const url of ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/_next/static/chunks/app.js", "/_next/static/chunks/app.css", "/_next/static/media/font.woff2"]) assert.ok(sw.includes(JSON.stringify(url)), `precaches ${url}`);
    assert.ok(!sw.includes('"/index.html"'), "the start page is cached as /");
    writeFileSync(join(out, "_next/static/chunks/app.js"), "changed");
    assert.notEqual(renderServiceWorker(template, out).match(/VERSION = "([^"]+)"/)![1], sw.match(/VERSION = "([^"]+)"/)![1], "a new build gets a new cache version");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("M7: counts of people use the right singular and plural", () => {
  assert.equal(peopleCount("fr", 0), "0 personne");
  assert.equal(peopleCount("fr", 1), "1 personne");
  assert.equal(peopleCount("fr", 2), "2 personnes");
  assert.equal(peopleCount("en", 1), "1 person");
  assert.equal(peopleCount("en", 3), "3 people");
  assert.equal(peopleCount("ar", 1), "شخص واحد");
  assert.equal(peopleCount("ar", 2), "شخصان");
  assert.equal(peopleCount("ar", 5), "5 أشخاص");
  assert.equal(peopleCount("ar", 11), "11 شخصاً");
});

test("M10: wrong PIN attempts slow down after five tries", () => {
  assert.equal(pinDelayMs(0), 0);
  assert.equal(pinDelayMs(4), 0);
  assert.equal(pinDelayMs(5), 30_000);
  assert.equal(pinDelayMs(6), 60_000);
  assert.equal(pinDelayMs(7), 120_000);
  assert.equal(pinDelayMs(30), 15 * 60_000, "capped at 15 minutes");
});

const LANGS = ["ar", "fr", "en"] as const;
const literals = (file: string, re: RegExp) => [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(re)].map((m) => m[1]);

test("M2: invoice states are translated", () => {
  for (const lang of LANGS) for (const s of ["draft", "posted", "voided"]) assert.notEqual(translate(lang, `st_${s}` as never), `st_${s}`, `${lang} st_${s}`);
});

test("M2: every CSV import error code has a readable message", () => {
  const codes = new Set(literals("../lib/core/csvImport.ts", /errors\.push\("([a-z_]+)"\)/g));
  for (const c of literals("../lib/core/money.ts", /error: "([a-z_]+)"/g)) codes.add("amount_" + c);
  assert.ok(codes.size > 15);
  for (const lang of LANGS) for (const code of codes) assert.ok(!importErrorMessage(lang, code).includes(code), `${lang} ${code}: ${importErrorMessage(lang, code)}`);
});

test("M2: audit actions, record types, reminder channels and snapshots have readable labels", () => {
  const actions = new Set(literals("../lib/core/commands.ts", /"([a-z]+\.[a-z_]+)"/g).filter((a) => !a.includes("_") || a.split(".")[0] !== "lib"));
  assert.ok(actions.size > 20);
  // Built from templates in commands.ts: `adjustment.${type}` and `recurring.${action}`.
  for (const type of ["increase", "decrease", "waiver", "write_off"]) actions.add(`adjustment.${type}`);
  for (const action of ["pause", "resume", "end"]) actions.add(`recurring.${action}`);
  for (const lang of LANGS) {
    const fallback = auditActionLabel(lang, "unknown.action");
    for (const a of actions) assert.ok(!auditActionLabel(lang, a).includes(a) && auditActionLabel(lang, a) !== fallback, `${lang} audit ${a}`);
    for (const s of DATA_STORES) assert.notEqual(storeLabel(lang, s), s, `${lang} store ${s}`);
    for (const c of ["whatsapp", "sms", "email", "copy", "local_notification"] as const) assert.notEqual(channelLabel(lang, c), c, `${lang} channel ${c}`);
    for (const r of ["before merge", "before replace"]) assert.ok(!snapshotLabel(lang, r).includes("before"), `${lang} snapshot ${r}`);
  }
});

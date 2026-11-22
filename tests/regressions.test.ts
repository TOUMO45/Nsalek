// Regressions found during development, plus the deterministic sentence → draft parser.
import test from "node:test";
import assert from "node:assert/strict";
import { dryRunImport, commitPayload } from "../lib/core/csvImport.ts";
import { parseSentence } from "../lib/core/parse.ts";
import { partyBalance, searchParties } from "../lib/core/ledger.ts";
import { seedDemo } from "../lib/demo.ts";
import { validateLedger } from "../lib/core/backup.ts";
import { basic, harness, loadAll, NOW, TODAY } from "./helpers.ts";
import type { Party } from "../lib/core/types.ts";

test("commitImport ignores reversed allocations on voided debts (found by the CSV track)", async () => {
  const h = await basic();
  const { partyId } = await h.run("createParty", { workspaceId: h.workspaceId, displayName: "Amine", phones: ["0770112233"] });
  const { obligationId } = await h.run("createObligation", { workspaceId: h.workspaceId, partyId, direction: "receivable", currency: "DZD", principal: 1000, date: "2026-11-01" });
  const { paymentId } = await h.run("recordPayment", { workspaceId: h.workspaceId, partyId, direction: "receivable", currency: "DZD", amount: 1000, date: "2026-11-02" });
  await h.run("reversePayment", { paymentId, reason: "typo" });
  await h.run("voidObligation", { obligationId, reason: "typo" });
  const text = "type,name,phone,direction,amount,currency,date\r\ndebt,Amine,0770112233,receivable,50,DZD,2026-11-05\r\n";
  const d = await dryRunImport({
    text,
    mapping: { type: 0, partyName: 1, phone: 2, direction: 3, amount: 4, currency: 5, date: 6, dateFormat: "YYYY-MM-DD", amountUnit: "major", defaultCurrency: "DZD", matchByName: false, allowAdvance: false },
    data: await loadAll(h.store),
    workspaceId: h.workspaceId,
    today: TODAY,
    fileName: "x.csv",
    now: NOW.toISOString(),
  });
  assert.equal(d.rows[0].status, "ok");
  await h.run("commitImport", commitPayload(d));
  const idx = await h.index(h.workspaceId);
  assert.equal(partyBalance(idx, partyId, TODAY).get("DZD")!.receivable, 5000);
});

test("commitImport refuses an imported payment with an unallocated remainder unless it is an explicit advance", async () => {
  const h = await basic();
  const pay = {
    id: "pay_imp_1",
    workspaceId: h.workspaceId,
    partyId: h.partyId,
    direction: "receivable",
    currency: "DZD",
    amount: 500,
    date: "2026-11-01",
    method: "cash",
    methodLabel: "",
    reference: "",
    note: "",
    allowAdvance: false,
    state: "posted",
    attachmentIds: [],
    createdAt: NOW.toISOString(),
    createdBy: "import",
  };
  await assert.rejects(h.run("commitImport", { workspaceId: h.workspaceId, source: "csv", fileName: "a", fileHash: "h1", records: { parties: [], obligations: [], payments: [pay], allocations: [] } }), /import_unallocated/);
  await h.run("commitImport", { workspaceId: h.workspaceId, source: "csv", fileName: "a", fileHash: "h1", records: { parties: [], obligations: [], payments: [{ ...pay, allowAdvance: true }], allocations: [] } });
});

test("the demo workspace is internally consistent and matches its documented totals", async () => {
  const h = harness();
  let n = 0;
  const run = async <T,>(type: string, payload: Record<string, unknown>) => (await h.raw(type, payload, `demo${++n}`)).result as T;
  const ws = await seedDemo(run as never, { lang: "fr", mode: "business", today: TODAY });
  const data = await loadAll(h.store);
  assert.deepEqual(validateLedger(data), []);
  const idx = await h.index(ws);
  let receivable = 0;
  let payable = 0;
  for (const p of idx.parties) {
    const b = partyBalance(idx, p.id, TODAY).get("DZD");
    receivable += b?.receivable ?? 0;
    payable += b?.payable ?? 0;
  }
  assert.equal(receivable, 9_105_000); // 91 050,00 DA (checked by hand in the browser walk-through)
  assert.equal(payable, 3_500_000); // 35 000,00 DA
});

const party = (id: string, displayName: string): Party => ({
  id,
  workspaceId: "w",
  kind: "person",
  displayName,
  phones: [],
  email: "",
  address: "",
  taxId: "",
  tags: [],
  isCustomer: false,
  isSupplier: false,
  notes: "",
  creditLimits: {},
  representatives: [],
  createdAt: "",
});

test("sentence parser proposes a reviewable draft and flags uncertainty instead of guessing", () => {
  const people = [party("p1", "Karim Benali"), party("p2", "Samira")];
  const a = parseSentence("Karim Benali a pris 2000 DA hier", people, TODAY);
  assert.equal(a.partyId, "p1");
  assert.equal(a.amountText, "2000");
  assert.equal(a.direction, "receivable");
  assert.equal(a.date, "2026-11-21");
  assert.deepEqual(a.uncertain, []);

  const b = parseSentence("سلفني Samira ٥٠٠٠", people, TODAY);
  assert.equal(b.partyId, "p2");
  assert.equal(b.amountText, "5000");
  assert.equal(b.direction, "payable");

  const c = parseSentence("Yacine 2 million", people, TODAY);
  assert.equal(c.partyId, null);
  assert.ok(c.uncertain.includes("party"));
  assert.ok(c.uncertain.includes("direction"));
  assert.equal(c.amountText, "2");
  assert.ok(c.uncertain.includes("amount"), "a number word next to the digits makes the amount uncertain");
  const d = parseSentence("Karim a pris mardi", people, TODAY);
  assert.ok(d.uncertain.includes("amount"));
  assert.ok(d.uncertain.includes("date"));
});

test("phone search matches local-format prefixes and E.164 fragments (found by the benchmark track)", async () => {
  const h = await basic();
  const { partyId } = await h.run("createParty", { workspaceId: h.workspaceId, displayName: "Leila", phones: ["0550 02 36 80"] });
  const idx = await h.index(h.workspaceId);
  for (const q of ["05500236", "0550 02 36 80", "+213 550 023 680", "023680", "213550"])
    assert.deepEqual(searchParties(idx, q, {}, TODAY).map((m) => m.party.id), [partyId], q);
  assert.deepEqual(searchParties(idx, "0661", {}, TODAY), []);
});

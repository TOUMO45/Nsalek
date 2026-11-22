// CSV export (formula guard, quoting, workspace isolation) and the import pipeline
// (decode → parse → dry run → commitImport → reverseImport).
import test from "node:test";
import assert from "node:assert/strict";
import {
  amountDecimal,
  decodeCsvBytes,
  detectDelimiter,
  exportObligations,
  exportParties,
  exportPayments,
  numberCell,
  parseCsv,
  textCell,
  toCsv,
} from "../lib/core/csv.ts";
import { commitPayload, csvTemplate, dryRunImport, parseDateCell, suggestMapping, type ImportMapping } from "../lib/core/csvImport.ts";
import { figuresOf, partyBalance, workspaceTotals } from "../lib/core/ledger.ts";
import { basic, DA, harness, loadAll, NOW, TODAY } from "./helpers.ts";

const HEAD = "type,name,phone,direction,amount,currency,date,due_date,description,reference";
const file = (...lines: string[]) => [HEAD, ...lines].join("\r\n") + "\r\n";
const MAP = (over: Partial<ImportMapping> = {}): ImportMapping => ({
  type: 0,
  partyName: 1,
  phone: 2,
  direction: 3,
  amount: 4,
  currency: 5,
  date: 6,
  dueDate: 7,
  description: 8,
  reference: 9,
  dateFormat: "YYYY-MM-DD",
  amountUnit: "major",
  defaultCurrency: "DZD",
  matchByName: false,
  allowAdvance: false,
  ...over,
});
type H = Awaited<ReturnType<typeof basic>>;
const dry = async (h: H, text: string, over: Partial<ImportMapping> = {}, fileName = "import.csv") =>
  dryRunImport({ text, mapping: MAP(over), data: await loadAll(h.store), workspaceId: h.workspaceId, today: TODAY, fileName, now: NOW.toISOString() });
const totals = async (h: H) => {
  const t = workspaceTotals(await h.index(h.workspaceId), TODAY).get("DZD");
  return { receivable: t?.receivable ?? 0, payable: t?.payable ?? 0, advances: t?.advanceReceived ?? 0 };
};

// ---------------------------------------------------------------- export primitives

test("export: text cells are formula-guarded, generated numeric amount cells are not", () => {
  const out = toCsv(
    [[textCell("=1+1"), textCell("+213"), textCell("-x"), textCell("@SUM(A1)"), textCell("\tx"), textCell("\rx"), textCell("safe"), "=raw", numberCell(-150050, "DZD"), numberCell(150050, "DZD"), -3, null]],
    { bom: false },
  );
  assert.deepEqual(parseCsv(out, ",").rows, [["'=1+1", "'+213", "'-x", "'@SUM(A1)", "'\tx", "'\rx", "safe", "'=raw", "-1500.50", "1500.50", "-3", ""]]);
  assert.equal(amountDecimal(150050, "DZD"), "1500.50");
  assert.equal(amountDecimal(5, "DZD"), "0.05");
  assert.equal(amountDecimal(1500, "XOF"), "1500");
  assert.equal(amountDecimal(1234567, "TND"), "1234.567");
  assert.ok(!out.startsWith("﻿"));
  assert.ok(toCsv([["a"]]).startsWith("﻿"), "BOM by default");
});

test("export: RFC 4180 quoting round trip with embedded ; quotes and newlines", () => {
  const rows = [
    ["a;b", 'say "hi"', "line1\nline2", "", "plain"],
    ["x", "y\r\nz", "1,5", "é ü ليك", "end"],
  ];
  const out = toCsv([...rows, ["n", null, 7, "", "z"]], { delimiter: ";" });
  assert.ok(out.startsWith("﻿"));
  assert.ok(out.endsWith("\r\n"));
  assert.ok(out.includes('"a;b";"say ""hi""";"line1\nline2";;plain\r\n'));
  const parsed = parseCsv(out);
  assert.equal(parsed.delimiter, ";");
  assert.deepEqual(parsed.rows, [...rows, ["n", "", "7", "", "z"]]);
  assert.deepEqual(parsed.lines, [1, 3, 5], "rows spanning lines keep their starting line");
  assert.throws(() => parseCsv('a,"open\nb,c'), /csv_unterminated_quote/);
});

test("import: delimiter detection picks ; and ignores delimiters inside quotes", () => {
  const text = 'type;name;amount\r\ndebt;"Benali; Karim";1500,50\r\ndebt;Nadia;2,5\r\n';
  assert.equal(detectDelimiter(text), ";");
  assert.deepEqual(parseCsv(text).rows, [
    ["type", "name", "amount"],
    ["debt", "Benali; Karim", "1500,50"],
    ["debt", "Nadia", "2,5"],
  ]);
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3\n"), "\t");
  assert.equal(detectDelimiter("a,b\n1,2\n"), ",");
});

test("import: decoding detects UTF-8 BOM, UTF-16LE BOM, and falls back to windows-1252", () => {
  const cp1252 = decodeCsvBytes(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x3b, 0x31]));
  assert.deepEqual(cp1252, { text: "Café;1", encoding: "windows-1252", bom: false });
  const bom = decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Café;١٥٠٠")]));
  assert.deepEqual(bom, { text: "Café;١٥٠٠", encoding: "utf-8", bom: true });
  const plain = decodeCsvBytes(new TextEncoder().encode("Hélène"));
  assert.deepEqual(plain, { text: "Hélène", encoding: "utf-8", bom: false });
  assert.deepEqual(decodeCsvBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00])), { text: "Aé", encoding: "utf-16le", bom: true });
});

// ---------------------------------------------------------------- import validation

test("import: DD/MM/YYYY dates and Arabic-Indic digits parse; ambiguous, future and unclear rows are errors", async () => {
  const h = await basic();
  const d = await dry(
    h,
    file(
      "debt,Samia,,receivable,١٥٠٠٫٥٠,DZD,01/11/2026,15/12/2026,,", // 2 ok
      'debt,Samir,,receivable,"1,500",DZD,05/11/2026,,,', // 3
      "debt,Nadia,,receivable,1500,DZD,01/12/2026,,,", // 4 future
      "debt,Nadia,,receivable,1500,DZD,31/02/2026,,,", // 5
      "debt,Nadia,,receivable,100+50,DZD,01/11/2026,,,", // 6
      "debt,Nadia,,sideways,1500,DZD,01/11/2026,,,", // 7
      "debt,Nadia,,receivable,1500,DZD,05/11/2026,01/11/2026,,", // 8
      "loan?,,,payable,abc,XYZ,2026-11-01,,,", // 9
      "debt,Nadia,12,receivable,1500 مليون,DZD,01/11/2026,,,", // 10
    ),
    { dateFormat: "DD/MM/YYYY" },
  );
  const ok = d.rows[0];
  assert.equal(ok.status, "ok");
  assert.equal(ok.preview.amount, 150050);
  assert.equal(ok.preview.date, "2026-11-01");
  assert.equal(ok.preview.dueDate, "2026-12-15");
  assert.deepEqual(
    d.rows.slice(1).map((r) => [r.line, r.status, r.errors]),
    [
      [3, "error", ["amount_ambiguous_separator"]],
      [4, "error", ["future_date"]],
      [5, "error", ["invalid_date"]],
      [6, "error", ["amount_expression"]],
      [7, "error", ["invalid_direction"]],
      [8, "error", ["due_before_date"]],
      [9, "error", ["invalid_type", "name_required", "invalid_currency", "invalid_date"]],
      [10, "error", ["invalid_phone", "amount_number_words"]],
    ],
  );
  assert.equal(d.records.obligations.length, 1);
  assert.equal(d.records.parties.length, 1, "no party is created for rejected rows");
  assert.deepEqual(d.counts, { rows: 9, ok: 1, error: 8, duplicate: 0, newParties: 1, matchedParties: 0, obligations: 1, payments: 0, allocations: 0 });
  const errors = parseCsv(d.errorsCsv).rows;
  assert.deepEqual(errors[0], ["line", "code"]);
  assert.deepEqual(errors[1], ["3", "amount_ambiguous_separator"]);
  assert.equal(errors.length, 1 + 12);

  assert.equal(parseDateCell("11/01/2026", "MM/DD/YYYY"), "2026-11-01");
  assert.equal(parseDateCell("٢٠٢٦-١١-٠١", "YYYY-MM-DD"), "2026-11-01");
  assert.equal(parseDateCell("01/11/26", "DD/MM/YYYY"), null, "two-digit years are not guessed");
  const centimes = await dry(h, file("debt,Samia,,receivable,150050,DZD,2026-11-01,,,", "debt,Samia,,receivable,1000,EUR,2026-11-01,,,"), { amountUnit: "centime" });
  assert.equal(centimes.rows[0].preview.amount, 150050);
  assert.deepEqual(centimes.rows[1].errors, ["centime_requires_dzd"]);
  await assert.rejects(dry(h, file(), { amount: null }), /mapping_required/);
});

// ---------------------------------------------------------------- dry run → commit → reverse

const FLOW = file(
  "debt,Karim Benali,0550 12 34 56,receivable,15000,DZD,2026-11-01,2026-12-01,Ciment,F-001",
  "debt,Karim Benali,0550123456,ليك,5000,DZD,2026-11-05,,Sable,F-002",
  "payment,Karim Benali,+213550123456,receivable,12000,DZD,2026-11-10,,Espèces,R-1",
  "debt,Fournisseur Sud,0661000000,payable,8000,DZD,2026-11-02,,,",
  "payment,Fournisseur Sud,0661000000,dette,3000,DZD,2026-11-03,,,",
);

async function imported() {
  const h = await basic();
  const d = await dry(h, FLOW);
  const { batchId } = await h.run("commitImport", commitPayload(d));
  return { ...h, d, batchId: batchId as string };
}

test("import: dry run → commitImport → balances match the file; payments allocate to debts from earlier rows", async () => {
  const h = await basic();
  const before = await loadAll(h.store);
  const d = await dry(h, FLOW);
  assert.deepEqual(await loadAll(h.store), before, "a dry run writes nothing");
  assert.equal(d.delimiter, ",");
  assert.deepEqual(d.counts, { rows: 5, ok: 5, error: 0, duplicate: 0, newParties: 2, matchedParties: 0, obligations: 3, payments: 2, allocations: 3 });
  const [ciment, sable, pay, supplierDebt] = d.rows;
  assert.equal(new Set([ciment, sable, pay].map((r) => r.preview.partyId)).size, 1, "same phone in three formats is one person");
  // Oldest due first: Sable (no due date, dated 11-05) before Ciment (due 12-01).
  assert.deepEqual(pay.preview.allocations, [
    { obligationId: sable.preview.recordId, amount: DA(5_000) },
    { obligationId: ciment.preview.recordId, amount: DA(7_000) },
  ]);
  assert.deepEqual(d.totals, [
    { currency: "DZD", direction: "payable", debts: DA(8_000), payments: DA(3_000), advances: 0 },
    { currency: "DZD", direction: "receivable", debts: DA(20_000), payments: DA(12_000), advances: 0 },
  ]);
  const h12 = d.fileHash.slice(0, 12);
  for (const r of [...d.records.obligations, ...d.records.payments]) {
    assert.equal(r.workspaceId, h.workspaceId);
    assert.equal(r.state, "posted");
    assert.equal(r.createdBy, "import");
    assert.equal(r.createdAt, NOW.toISOString());
    assert.match(r.importFingerprint!, /^[0-9a-f]{64}$/);
    assert.ok(r.id.startsWith(`csv_${h12}_`));
  }
  assert.deepEqual(d.records.parties.map((p) => [p.displayName, p.phones]), [
    ["Karim Benali", ["+213550123456"]],
    ["Fournisseur Sud", ["+213661000000"]],
  ]);

  const { batchId } = await h.run("commitImport", commitPayload(d));
  const idx = await h.index(h.workspaceId);
  assert.equal(partyBalance(idx, ciment.preview.partyId!, TODAY).get("DZD")!.receivable, DA(8_000));
  assert.equal(partyBalance(idx, supplierDebt.preview.partyId!, TODAY).get("DZD")!.payable, DA(5_000));
  assert.equal(figuresOf(idx, idx.obligation.get(ciment.preview.recordId!)!).outstanding, DA(8_000));
  assert.equal(figuresOf(idx, idx.obligation.get(sable.preview.recordId!)!).outstanding, 0);
  assert.equal(idx.obligation.get(ciment.preview.recordId!)!.importBatchId, batchId);
  assert.equal(idx.party.get(ciment.preview.partyId!)!.importBatchId, batchId);
  assert.deepEqual(await totals(h), { receivable: DA(8_000), payable: DA(5_000), advances: 0 });
  const batch = idx.data.importBatches.find((b) => b.id === batchId)!;
  assert.equal(batch.fileHash, d.fileHash);
  assert.deepEqual(batch.counts, { parties: 2, obligations: 3, payments: 2, allocations: 3 });
});

test("import: the same file again → already_imported, and its rows are marked duplicate", async () => {
  const h = await imported();
  const again = await dry(h, FLOW);
  assert.equal(again.alreadyImported, true);
  assert.equal(again.fileHash, h.d.fileHash);
  assert.deepEqual(again.rows.map((r) => r.status), ["duplicate", "duplicate", "duplicate", "duplicate", "duplicate"]);
  assert.deepEqual(again.rows[0].preview.duplicateOf, { store: "obligations", id: h.d.rows[0].preview.recordId });
  assert.equal(again.records.parties.length + again.records.obligations.length + again.records.payments.length, 0);
  await assert.rejects(h.run("commitImport", commitPayload(again)), /already_imported/);
  await assert.rejects(h.run("commitImport", commitPayload(h.d)), /already_imported/);
  // Same rows under another hash (one trailing blank line) are still caught row by row.
  const copy = await dry(h, FLOW + "\r\n", {}, "copy.csv");
  assert.notEqual(copy.fileHash, h.d.fileHash);
  assert.equal(copy.counts.duplicate, 5);
  // Within one file, a repeated row is a duplicate of the earlier line.
  const twice = await dry(h, file("debt,Lina,,receivable,700,DZD,2026-11-01,,,", "debt,Lina,,receivable,700,DZD,2026-11-01,,,"), {}, "twice.csv");
  assert.deepEqual(twice.rows.map((r) => r.status), ["ok", "duplicate"]);
  assert.deepEqual(twice.rows[1].preview.duplicateOf, { line: 2 });
  // A new row in an otherwise known file matches the imported person by phone and is the only one imported.
  const more = await dry(h, FLOW + "payment,K. Benali,0550123456,receivable,1000,DZD,2026-11-20,,,R-2\r\n", {}, "more.csv");
  assert.equal(more.counts.ok, 1);
  assert.equal(more.counts.duplicate, 5);
  const extra = more.rows[5];
  assert.equal(extra.preview.party, "matched_phone");
  assert.ok(extra.preview.warnings.includes("name_differs"));
  assert.deepEqual(extra.preview.allocations, [{ obligationId: h.d.rows[0].preview.recordId, amount: DA(1_000) }]);
  await h.run("commitImport", commitPayload(more));
  assert.deepEqual(await totals(h), { receivable: DA(7_000), payable: DA(5_000), advances: 0 });
});

test("import: reverseImport brings totals back to zero, keeps history, and the file can be imported again", async () => {
  const h = await imported();
  await h.run("reverseImport", { batchId: h.batchId, reason: "wrong file" });
  assert.deepEqual(await totals(h), { receivable: 0, payable: 0, advances: 0 });
  const idx = await h.index(h.workspaceId);
  assert.ok(h.d.records.obligations.every((o) => idx.obligation.get(o.id)!.state === "voided"));
  assert.ok(h.d.records.payments.every((p) => idx.payment.get(p.id)!.state === "reversed"));
  assert.ok(h.d.records.parties.every((p) => idx.party.get(p.id)!.archivedAt));

  const again = await dry(h, FLOW);
  assert.equal(again.alreadyImported, false);
  assert.equal(again.counts.ok, 5, "voided/reversed records do not count as duplicates");
  assert.ok(again.records.obligations.every((o) => o.id.includes("_r1_")), "new ids, no collision with voided ones");
  assert.ok(again.newParties.every((p) => p.possibleDuplicates.length === 1), "archived people from the reversed batch are flagged");
  await h.run("commitImport", commitPayload(again));
  assert.deepEqual(await totals(h), { receivable: DA(8_000), payable: DA(5_000), advances: 0 });
});

test("import: existing person matched by phone; excess payment is an error unless advances are allowed", async () => {
  const h = await basic();
  const { partyId } = await h.run("createParty", { workspaceId: h.workspaceId, displayName: "Amine", phones: ["0770 11 22 33"] });
  const { obligationId } = await h.run("createObligation", { workspaceId: h.workspaceId, partyId, direction: "receivable", currency: "DZD", principal: DA(10_000), date: "2026-11-01" });
  const text = file("payment,Amine B.,0770112233,receivable,4000,DZD,2026-11-15,,,", "payment,Amine B.,0770112233,receivable,7000,DZD,2026-11-16,,,");
  const strict = await dry(h, text);
  const [first, second] = strict.rows;
  assert.equal(first.status, "ok");
  assert.equal(first.preview.party, "matched_phone");
  assert.equal(first.preview.partyId, partyId);
  assert.deepEqual(first.preview.warnings, ["name_differs"]);
  assert.deepEqual(first.preview.allocations, [{ obligationId, amount: DA(4_000) }]);
  assert.deepEqual(second.errors, ["overpayment"]);
  assert.equal(second.preview.unallocated, DA(1_000));
  assert.deepEqual(strict.matchedParties, [{ id: partyId, displayName: "Amine", by: "phone", lines: [2] }]);
  assert.equal(strict.records.parties.length, 0);

  const loose = await dry(h, text, { allowAdvance: true });
  assert.equal(loose.counts.ok, 2);
  await h.run("commitImport", commitPayload(loose));
  const b = partyBalance(await h.index(h.workspaceId), partyId, TODAY).get("DZD")!;
  assert.equal(b.receivable, 0);
  assert.equal(b.advanceReceived, DA(1_000));
});

test("import: a name alone never matches an existing person unless matchByName is on", async () => {
  const h = await basic(); // has "Karim", no phone
  const text = file("debt,  karim ,,receivable,100,DZD,2026-11-01,,,", "debt,Nadia,,receivable,50,DZD,2026-11-01,,,A", "debt,nadia,,receivable,60,DZD,2026-11-02,,,B");
  const byDefault = await dry(h, text);
  assert.equal(byDefault.rows[0].preview.party, "new");
  assert.deepEqual(byDefault.newParties[0].possibleDuplicates, [{ id: h.partyId, displayName: "Karim" }]);
  assert.equal(byDefault.newParties.length, 2, "one new person per distinct normalized name+phone");
  assert.deepEqual(byDefault.newParties[1].lines, [3, 4]);
  const byName = await dry(h, text, { matchByName: true });
  assert.equal(byName.rows[0].preview.party, "matched_name");
  assert.equal(byName.rows[0].preview.partyId, h.partyId);
  assert.equal(byName.records.parties.length, 1);
});

test("import: each language template parses, maps itself and imports cleanly", async () => {
  for (const lang of ["en", "fr", "ar"] as const) {
    const text = csvTemplate(lang);
    assert.ok(text.startsWith("﻿"));
    const parsed = parseCsv(text);
    assert.equal(parsed.rows.length, 3, lang);
    const suggested = suggestMapping(parsed.rows[0]);
    assert.deepEqual(suggested, { type: 0, partyName: 1, phone: 2, direction: 3, amount: 4, currency: 5, date: 6, dueDate: 7, description: 8, reference: 9 }, lang);
    const h = await basic();
    const d = await dryRunImport({
      text,
      mapping: { dateFormat: "YYYY-MM-DD", amountUnit: "major", defaultCurrency: "DZD", matchByName: false, allowAdvance: false, ...suggested },
      data: await loadAll(h.store),
      workspaceId: h.workspaceId,
      today: TODAY,
      fileName: `template-${lang}.csv`,
    });
    assert.equal(d.counts.ok, 2, lang);
    assert.equal(d.rows[1].preview.allocations[0].amount, DA(5_000), lang);
    await h.run("commitImport", commitPayload(d));
    assert.equal((await totals(h)).receivable, DA(10_000), lang);
  }
});

// ---------------------------------------------------------------- workspace isolation

test("export: one workspace's files never contain another workspace's people", async () => {
  const h = harness();
  const a = await h.run("createWorkspace", { name: "A" });
  const b = await h.run("createWorkspace", { name: "B" });
  const pa = await h.run("createParty", { workspaceId: a.workspaceId, displayName: "Alpha Visible", phones: ["0550 00 00 01"] });
  const pb = await h.run("createParty", { workspaceId: b.workspaceId, displayName: "Beta Secret" });
  await h.run("createObligation", { workspaceId: a.workspaceId, partyId: pa.partyId, direction: "receivable", currency: "DZD", principal: 150050, date: "2026-11-01", description: '=HYPERLINK("http://x")' });
  await h.run("recordPayment", { workspaceId: a.workspaceId, partyId: pa.partyId, direction: "receivable", currency: "DZD", amount: 50050, date: "2026-11-02" });
  await h.run("createObligation", { workspaceId: b.workspaceId, partyId: pb.partyId, direction: "payable", currency: "EUR", principal: 999, date: "2026-11-01", description: "Beta Secret deal" });
  await h.run("recordPayment", { workspaceId: b.workspaceId, partyId: pb.partyId, direction: "payable", currency: "EUR", amount: 100, date: "2026-11-02", note: "Beta Secret" });
  const data = await loadAll(h.store);
  const opts = { today: TODAY };
  const files = [exportParties(data, a.workspaceId, opts), exportObligations(data, a.workspaceId, opts), exportPayments(data, a.workspaceId, opts)];
  for (const f of files) {
    assert.ok(!f.includes("Beta Secret"));
    assert.ok(!f.includes(pb.partyId));
    assert.ok(!f.includes("EUR"));
  }
  const table = (text: string) => {
    const [head, ...rows] = parseCsv(text).rows;
    return rows.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
  };
  assert.deepEqual(table(files[0]), [
    { party_id: pa.partyId, name: "Alpha Visible", phones: "0550 00 00 01", currency: "DZD", receivable: "1000.00", payable: "0.00", advance_received: "0.00", advance_paid: "0.00", overdue_receivable: "0.00", overdue_payable: "0.00", archived: "false" },
  ]);
  const [ob] = table(files[1]);
  assert.equal(ob.principal, "1500.50");
  assert.equal(ob.paid, "500.50");
  assert.equal(ob.outstanding, "1000.00");
  assert.equal(ob.status, "partly_paid");
  assert.equal(ob.description, `'=HYPERLINK("http://x")`);
  const [pay] = table(files[2]);
  assert.deepEqual([pay.amount, pay.allocated, pay.unallocated, pay.state], ["500.50", "500.50", "0.00", "posted"]);
  assert.ok(exportParties(data, b.workspaceId, opts).includes("Beta Secret"));
  assert.equal(parseCsv(exportParties(data, a.workspaceId, { ...opts, lang: "fr" })).rows[0][1], "Nom");
});

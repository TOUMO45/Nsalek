// Contacts from a phone's .vcf export or the browser's contact picker.
import test from "node:test";
import assert from "node:assert/strict";
import { fromPicker, parseVcf, planContacts } from "../lib/core/contacts.ts";
import { loadLedger } from "../lib/core/restore.ts";
import { basic } from "./helpers.ts";

const VCF = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Karim Benali",
  "N:Benali;Karim;;;",
  "TEL;TYPE=CELL:0550 12 34 56",
  "TEL;TYPE=WORK:+213 21 00 00 00",
  "EMAIL:karim@example.com",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:2.1",
  "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D8=A8=D9=86=D8=B9=D9=84=D9=8A;=D8=B3=D9=85=D9=8A=D8=B1=D8=A9;;;",
  "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D8=B3=D9=85=D9=8A=D8=B1=D8=A9 =D8=A8=D9=86=D8=B9=D9=84=",
  "=D9=8A",
  "TEL;CELL:0661987654",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Épicerie\\, Nour",
  " Centre",
  "item1.TEL;VALUE=uri:tel:+33612345678",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "TEL:0770000000",
  "END:VCARD",
].join("\r\n");

test("contacts: vCard 2.1, 3.0 and 4.0, folded lines, Arabic in quoted-printable, escapes", () => {
  const c = parseVcf(VCF);
  assert.equal(c.length, 4);
  assert.deepEqual(c[0], { name: "Karim Benali", phones: ["0550 12 34 56", "+213 21 00 00 00"], email: "karim@example.com" });
  assert.equal(c[1].name, "سميرة بنعلي");
  assert.deepEqual(c[1].phones, ["0661987654"]);
  assert.equal(c[2].name, "Épicerie, NourCentre");
  assert.deepEqual(c[2].phones, ["+33612345678"]);
  assert.equal(c[3].name, "");
});

test("contacts: the picker's lists become contacts; empty ones are dropped", () => {
  assert.deepEqual(fromPicker([{ name: ["Amina "], tel: ["0555 11 22 33", "0555 11 22 33"] }, { name: [], tel: [] }]), [{ name: "Amina", phones: ["0555 11 22 33"], email: "" }]);
});

test("contacts: people already in the notebook are shown, twins folded, nameless flagged", async () => {
  const h = await basic(); // "Karim"
  await h.run("createParty", { workspaceId: h.workspaceId, displayName: "Samira", phones: ["0661 98 76 54"] });
  const parties = (await loadLedger(h.store)).parties;
  const rows = planContacts([...parseVcf(VCF), ...parseVcf(VCF)], parties);
  assert.equal(rows.length, 4, "the same contact twice is one row");
  assert.deepEqual(rows[0].phonesE164, ["+213550123456", "+21321000000"]);
  assert.equal(rows[1].duplicates[0]?.displayName, "Samira", "same number");
  assert.equal(rows[0].duplicates.length, 0, "Karim Benali is not Karim");
  assert.equal(rows[3].problem, "no_name");
});

test("contacts: '+213 (0) 555...' is the right number, and a thousand contacts plan at once", async () => {
  const { normalizePhone } = await import("../lib/core/text.ts");
  assert.equal(normalizePhone("+213 (0) 555 12 34 56")?.value, "+213555123456");
  assert.equal(normalizePhone("0550 10 20 30")?.value, "+213550102030", "zeros elsewhere stay");
  const h = await basic();
  for (let i = 0; i < 50; i++) await h.run("createParty", { workspaceId: h.workspaceId, displayName: "P" + i, phones: ["0550" + String(100000 + i)] });
  const parties = (await loadLedger(h.store)).parties;
  const many = Array.from({ length: 5000 }, (_, i) => ({ name: "C" + i, phones: ["0660" + String(100000 + i)], email: "" }));
  many.push({ name: "x", phones: ["0550100007"], email: "" });
  const s = performance.now();
  const rows = planContacts(many, Array.from({ length: 1000 }, (_, i) => ({ ...parties[i % parties.length], id: "p" + i })));
  assert.ok(performance.now() - s < 1000, "fast");
  assert.equal(rows.at(-1)!.duplicates.length > 0, true, "same number found");
});

test("contacts: an imported contact is a normal person; a second import is refused as a duplicate", async () => {
  const h = await basic();
  const [row] = planContacts(parseVcf(VCF), (await loadLedger(h.store)).parties);
  await h.run("createParty", { workspaceId: h.workspaceId, displayName: row.name, phones: row.phonesE164, email: row.email });
  await assert.rejects(h.run("createParty", { workspaceId: h.workspaceId, displayName: row.name, phones: row.phonesE164 }), /possible_duplicate/);
  const p = (await loadLedger(h.store)).parties.find((x) => x.displayName === "Karim Benali")!;
  assert.deepEqual(p.phones, ["+213550123456", "+21321000000"]);
});

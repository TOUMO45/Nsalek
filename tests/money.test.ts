import test from "node:test";
import assert from "node:assert/strict";
import { formatMoney, parseAmount, toInputValue } from "../lib/core/money.ts";
import { addMonthsAnchored, daysBetween, isISODate, isoWeekKey, todayIn } from "../lib/core/dates.ts";
import { normalizePhone, normalizeText, phoneKey } from "../lib/core/text.ts";

const ok = (input: string, currency = "DZD", unit?: "major" | "centime") => {
  const r = parseAmount(input, currency, { unit });
  assert.ok(r.ok, `${input} → ${JSON.stringify(r)}`);
  return r.minor;
};
const err = (input: string, code: string, currency = "DZD", unit?: "major" | "centime") => {
  const r = parseAmount(input, currency, { unit });
  assert.ok(!r.ok && r.error === code, `${input} expected ${code}, got ${JSON.stringify(r)}`);
};

test("plain, grouped and decimal amounts in Latin and Arabic digits", () => {
  assert.equal(ok("1500"), 150000);
  assert.equal(ok("1 500"), 150000);
  assert.equal(ok("1 500,50"), 150050);
  assert.equal(ok("1500,5"), 150050);
  assert.equal(ok("1500.50"), 150050);
  assert.equal(ok("1.500.000"), 150000000);
  assert.equal(ok("1,500,000"), 150000000);
  assert.equal(ok("1.500,25"), 150025);
  assert.equal(ok("1,500.25"), 150025);
  assert.equal(ok("٢٥٠٠"), 250000);
  assert.equal(ok("١٬٥٠٠٫٥٠"), 150050);
  assert.equal(ok("۳۰۰"), 30000);
  assert.equal(ok("0,500"), 50, "leading zero makes the comma a decimal; trailing zero is exact");
  assert.equal(ok("2500 DA"), 250000);
  assert.equal(ok("2500 دج"), 250000);
});

test("ambiguous or lossy input is rejected, never silently changed", () => {
  err("1,500", "ambiguous_separator");
  err("1.500", "ambiguous_separator");
  err("1 500,000", "ambiguous_separator");
  err("12,345,67", "invalid");
  err("1500,555", "too_many_decimals");
  err("", "empty");
  err("0", "not_positive");
  err("-50", "not_positive");
  err("15 0", "invalid");
});

test("number words and colloquial units are never interpreted", () => {
  for (const s of ["2 million", "2 مليون", "5 ألف", "10k", "مية", "deux mille"]) err(s, "number_words");
});

test("restricted calculator: + − × ÷ and parentheses, exact rationals, visible rounding", () => {
  assert.equal(ok("1500+250"), 175000);
  assert.equal(ok("3 × 1 200"), 360000);
  assert.equal(ok("(2000 - 500) * 2"), 300000);
  assert.equal(ok("10 000 ÷ 4"), 250000);
  const r = parseAmount("10000/3", "DZD");
  assert.ok(r.ok && r.rounded && r.minor === 333333);
  err("10/0", "division_by_zero");
  err("5-10", "not_positive");
  err("2**3", "invalid");
  err("alert(1)", "number_words");
  err("((((1)", "invalid");
});

test("centime unit converts integers only and is limited to DZD", () => {
  assert.equal(ok("150000", "DZD", "centime"), 150000); // 150 000 centimes = 1 500 DA
  err("1500,5", "centimes_must_be_integer", "DZD", "centime");
  err("100", "invalid", "EUR", "centime");
});

test("currency exponents: TND has three decimals, XOF none", () => {
  assert.equal(ok("0,345", "TND"), 345);
  assert.equal(ok("12500,125", "TND"), 12500125);
  err("12 500,125", "ambiguous_separator", "TND"); // space grouping + 3 digits after a comma is ambiguous
  err("12,345", "ambiguous_separator", "TND"); // still ambiguous: type 12345 or 12 345,000
  assert.equal(ok("1500", "XOF"), 1500);
  err("1500,5", "too_many_decimals", "XOF");
});

test("formatting uses Latin digits and the local currency label", () => {
  assert.equal(formatMoney(150050, "DZD", "fr"), "1 500,50 DA");
  assert.equal(formatMoney(150050, "DZD", "ar"), "1 500,50 دج");
  assert.equal(formatMoney(123456789, "DZD", "fr"), "1 234 567,89 DA");
  assert.equal(formatMoney(150050, "DZD", "en"), "1,500.50 DZD");
  assert.equal(formatMoney(150050, "DZD", "fr", { hide: true }), "••••• DA");
  assert.equal(toInputValue(150000, "DZD", "fr"), "1500");
  assert.equal(toInputValue(150050, "DZD", "fr"), "1500,50");
});

test("dates: validation, end-of-month anchoring, week keys, time zone", () => {
  assert.ok(isISODate("2028-02-29"));
  assert.ok(!isISODate("2026-02-30"));
  assert.equal(addMonthsAnchored("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsAnchored("2026-01-31", 2), "2026-03-31");
  assert.equal(addMonthsAnchored("2027-12-31", 2), "2028-02-29");
  assert.equal(daysBetween("2026-11-01", "2026-11-22"), 21);
  assert.equal(isoWeekKey("2026-01-01"), "2026-W01");
  assert.equal(isoWeekKey("2027-01-01"), "2026-W53");
  // 23:30 UTC on Nov 22 is already Nov 23 in Algiers (UTC+1).
  assert.equal(todayIn("Africa/Algiers", new Date("2026-11-22T23:30:00Z")), "2026-11-23");
});

test("phones: Algerian domestic and international forms normalize to E.164", () => {
  assert.equal(normalizePhone("0550 12 34 56")?.value, "+213550123456");
  assert.equal(normalizePhone("+213 550-12-34-56")?.value, "+213550123456");
  assert.equal(normalizePhone("00213550123456")?.value, "+213550123456");
  assert.equal(normalizePhone("021 23 45 67")?.value, "+21321234567");
  assert.equal(normalizePhone("٠٥٥٠١٢٣٤٥٦")?.value, "+213550123456");
  assert.equal(normalizePhone("+33 6 12 34 56 78")?.value, "+33612345678");
  assert.equal(normalizePhone("12")?.e164, false);
  assert.equal(phoneKey("+213550123456"), phoneKey("0550 12 34 56"));
});

test("search normalization folds accents and Arabic letter variants", () => {
  assert.equal(normalizeText("Youcef Aït Ali"), "youcef ait ali");
  assert.equal(normalizeText("أحمد"), normalizeText("احمد"));
  assert.equal(normalizeText("فاطمة"), normalizeText("فاطمه"));
  assert.equal(normalizeText("مُحَمَّد"), "محمد");
});

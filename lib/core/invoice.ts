// Business documents. Totals use integer arithmetic with half-up rounding per line.
// This is a commercial document, not a tax-compliant invoice for any specific country.
import { check, type InvoiceLine, type Minor } from "./types.ts";

const roundDiv = (num: bigint, den: bigint): bigint => {
  const q = num / den;
  const r = num % den;
  return r * 2n >= den ? q + 1n : q;
};

export type LineTotals = { gross: Minor; discount: Minor; net: Minor; tax: Minor; total: Minor };

export function lineTotals(line: InvoiceLine): LineTotals {
  check(Number.isSafeInteger(line.quantityMilli) && line.quantityMilli > 0, "quantity_positive");
  check(Number.isSafeInteger(line.unitPrice) && line.unitPrice >= 0, "amount_invalid");
  check(Number.isInteger(line.discountBps) && line.discountBps >= 0 && line.discountBps <= 10_000, "discount_invalid");
  check(Number.isInteger(line.taxBps) && line.taxBps >= 0 && line.taxBps <= 10_000, "tax_invalid");
  const gross = roundDiv(BigInt(line.quantityMilli) * BigInt(line.unitPrice), 1000n);
  const discount = roundDiv(gross * BigInt(line.discountBps), 10_000n);
  const net = gross - discount;
  const tax = roundDiv(net * BigInt(line.taxBps), 10_000n);
  return { gross: Number(gross), discount: Number(discount), net: Number(net), tax: Number(tax), total: Number(net + tax) };
}

export function invoiceTotals(lines: InvoiceLine[]) {
  check(lines.length >= 1 && lines.length <= 200, "invoice_lines");
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  for (const l of lines) {
    check(typeof l.description === "string" && l.description.trim().length > 0, "line_description");
    const t = lineTotals(l);
    subtotal += t.gross;
    discount += t.discount;
    tax += t.tax;
  }
  const total = subtotal - discount + tax;
  check(total > 0, "amount_positive");
  return { subtotal, discount, tax, total };
}

/** "2,5" → 2500 thousandths. Up to three decimals. */
export function parseQuantity(input: string): number | null {
  const s = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  const v = Number(i) * 1000 + Number(f.padEnd(3, "0"));
  return v > 0 && Number.isSafeInteger(v) ? v : null;
}

// Text normalization for search and duplicate detection, and phone normalization.
import { normalizeDigits } from "./money.ts";

/** Lowercase, accent-free, Arabic-diacritic-free, alef/ya/ta-marbuta-normalized, Latin digits. */
export function normalizeText(input: string): string {
  return normalizeDigits(input ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ً-ٰٟۖ-ۭ]/g, "")
    .replace(/ـ/g, "")
    .replace(/[آأإٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export type PhoneResult = { value: string; e164: boolean };

/**
 * Normalizes a phone number. Algerian domestic forms (05/06/07 mobiles, 02x–04x landlines),
 * 213-prefixed and 00-prefixed numbers become E.164 (+213…). Other "+" numbers with 8–15 digits
 * are kept as E.164. Anything else is returned cleaned but flagged as not normalized.
 */
export function normalizePhone(input: string, country = "DZ"): PhoneResult | null {
  // "+213 (0) 555..." writes the trunk 0 that a number with its country code drops.
  const raw = normalizeDigits(input ?? "").replace(/\(0\)/g, "").replace(/[\s().\-/  ]/g, "");
  if (!raw) return null;
  let s = raw.startsWith("00") ? "+" + raw.slice(2) : raw;
  if (s.startsWith("+")) {
    const digits = s.slice(1);
    if (/^\d{8,15}$/.test(digits)) return { value: "+" + digits, e164: true };
    return { value: s, e164: false };
  }
  if (country === "DZ") {
    if (/^0[5-7]\d{8}$/.test(s)) return { value: "+213" + s.slice(1), e164: true };
    if (/^0[2-4]\d{7}$/.test(s)) return { value: "+213" + s.slice(1), e164: true };
    if (/^213\d{9}$/.test(s)) return { value: "+" + s, e164: true };
    if (/^[5-7]\d{8}$/.test(s)) return { value: "+213" + s, e164: true };
  }
  s = s.replace(/[^\d+]/g, "");
  return s ? { value: s, e164: false } : null;
}

/** Digits used to match phones regardless of format: the last 9 digits. */
export function phoneKey(phone: string): string {
  const digits = normalizeDigits(phone ?? "").replace(/\D/g, "");
  return digits.slice(-9);
}

/** Human display: +213 550 00 00 00 → "0550 00 00 00" for Algerian numbers. */
export function displayPhone(phone: string): string {
  if (/^\+213\d{9}$/.test(phone)) {
    const n = "0" + phone.slice(4);
    return `${n.slice(0, 4)} ${n.slice(4, 6)} ${n.slice(6, 8)} ${n.slice(8, 10)}`;
  }
  if (/^\+213\d{8}$/.test(phone)) {
    const n = "0" + phone.slice(4);
    return `${n.slice(0, 3)} ${n.slice(3, 5)} ${n.slice(5, 7)} ${n.slice(7, 9)}`;
  }
  return phone;
}

/** Digits for wa.me links (no plus sign). */
export function whatsappDigits(phone: string): string | null {
  const n = normalizePhone(phone);
  if (!n?.e164) return null;
  return n.value.slice(1);
}

export function initials(name: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => [...p][0]?.toUpperCase() ?? "").join("") || "?";
}

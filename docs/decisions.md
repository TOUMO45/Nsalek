# Decisions and assumptions

| # | Decision | Why | Tradeoff |
|---|---|---|---|
| D1 | Nsalek is a separate repository (`TOUMO45/Nsalek`). The clinic repository is read-only reference | Clinic has uncommitted work and a live Firebase project | Shared fixes must be ported by hand |
| D2 | Local-first. IndexedDB is the system of record; no account required | Master prompt asks for local mode, offline P0 and no silent connection to the clinic database | No multi-device until P2 sync |
| D3 | Same stack as the clinic (Next 16 static export, React 19, Tailwind 4); hosting plumbing dropped | Avoid a framework rewrite | — |
| D4 | Money is stored as integer minor units in JavaScript safe integers (max ≈ 9×10¹³ DZD) with a per-currency exponent (DZD/EUR/USD 2, TND 3) | No floating-point money | Amounts above the safe range are rejected |
| D5 | Posted entries are immutable. Corrections use adjustments (increase, decrease, waiver, write-off, netting), void + replace, or payment reversal; each needs a reason and is audited | Auditability | More records than in-place edits |
| D6 | Balances are **derived** from source records on every read; no cached totals | Cached totals cannot drift | Recomputed in memory (measured in `docs/performance.md`) |
| D7 | Every command runs inside one IndexedDB `readwrite` transaction over all stores it touches; the browser serializes overlapping transactions across tabs | Prevents double allocation (fixture L) | No awaiting non-IndexedDB work inside commands |
| D8 | Command ids double as idempotency keys (`commands` store); a retry returns the first result | Fixture E; future sync outbox | — |
| D9 | Overpayment is rejected unless the user explicitly records the excess as an unallocated advance | Never make a debt negative | One more decision in the payment form |
| D10 | Netting is an explicit operation that writes a linked pair of `netting` adjustments | Never net invisibly | — |
| D11 | Amount input rejects ambiguous forms (`1,500`, `1.500`) and number words (`مليون`, `million`, `ألف`); the user must type digits | Never change a value silently | Slightly stricter input |
| D12 | Centime mode: integer centimes are converted to DA and shown for confirmation before saving | Algerian usage of "centimes" | — |
| D13 | Statements are printed by the browser's print engine to PDF, using bundled IBM Plex Sans Arabic (Arabic + Latin) | Correct Arabic shaping without custom PDF code | Output depends on the browser print engine; verified with Edge |
| D14 | Real CSV only. No XLSX in this version | Master prompt forbids fake .xlsx | Users open CSV in Excel/LibreOffice |
| D15 | Encryption uses WebCrypto: PBKDF2-SHA-256 (310,000 iterations) + AES-GCM-256. A forgotten passphrase cannot be recovered | Standard vetted primitives; no custom cryptography | — |
| D16 | The PIN lock is a privacy screen, not encryption. The PIN is stored as a salted PBKDF2 hash | Honest labeling | Data at rest is as protected as the browser profile |
| D17 | Reminders: in-app due list always available; browser notifications only when the app is open or reopened; external messages through user-reviewed composers | No reliable closed-app scheduling on the web | No guaranteed delivery |
| D18 | Dates are stored as `YYYY-MM-DD` in the workspace time zone (default `Africa/Algiers`); aging uses whole local days | Deterministic buckets | — |
| D19 | Monthly schedules anchor on the start day. Months without that day use their last day (Jan 31 → Feb 28/29 → Mar 31) | Explicit end-of-month rule | — |
| D20 | The brand "Nsalek / نسالك" is a configurable placeholder in `lib/brand.ts` and is not trademark-cleared | Master prompt | — |
| D21 | Nothing is pushed, deployed or published without explicit authorization | Master prompt §14 | — |

## Assumptions to confirm

- A1: Browser/PWA is the only target in this version. Native mobile wrappers are not in the repository.
- A2: The default language at first launch is Arabic. FR and EN are one tap away.
- A3: The clinic export for migration is a JSON file shaped like the clinic's `Data` type (`clients, debts, payments, medicines, reminders`). This repository contains no script that reads the live clinic database.

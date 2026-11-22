# Current app audit: Agrovet / Vetna clinic debt app

Source inspected: `B:\Desktop\konashi_veto` on 2026-11-22, branch `main` at `5a3d330`, **plus uncommitted changes in 12 files** (`git status`). Nsalek is a separate repository (`B:\Desktop\Nsalek`). Nothing in the clinic repository was modified.

## 1. Platform and build

| Topic | Finding | Reference |
|---|---|---|
| Framework | Next.js 16.3.4 (App Router) with `output: "export"` static export, React 19.2.6, Tailwind 4.2.1 | `package.json`, `next.config.ts` |
| Extra tooling | vinext, Cloudflare Vite plugin, wrangler, drizzle (D1 example only). None are used by the clinic screens | `vite.config.ts`, `db/schema.ts`, `examples/d1` |
| UI | One client component tree with internal page state; no URL routing | `app/page.tsx`, `app/ui/Agrovet.tsx:66` |
| State | `useClinic()` hook. Demo mode mutates an in-memory clone; live mode calls the backend | `app/ui/useClinic.ts:23`, `:189` |
| Backend (committed) | One Firebase callable function `agrovet` (europe-west1) handles all actions in Firestore transactions | `functions/index.mjs:44`, `:80` |
| Backend (uncommitted) | `lib/firebase.ts` now routes every action to a client-side Firestore implementation | `lib/firebase.ts` (diff), `lib/firestoreApi.ts` (new, untracked) |
| Data storage | The clinic's live Firestore project (id in the clinic's `.firebaserc`): `clinics/agrovet/{clients,medicines,debts,payments,reminders,audit,operations,settings}` | `.firebaserc`, `functions/index.mjs:23-25` |
| Auth | Firebase Email/Password; membership doc `clinicMembers/{uid}` (committed rules) | `README.md` "Connect the real clinic" |
| Offline | Not supported for writes. `mutate()` throws `offline` | `app/ui/useClinic.ts:191` |
| Notifications | None. SMS reminders open the phone's SMS composer | `lib/sms.ts`, `app/ui/Editor.tsx:200` |
| Biometric/app lock | None | — |
| Commands | `dev`, `build`, `lint`, `test` (`node --test functions/test/core.test.mjs`), `test:integration` (Firestore emulator, needs Java 21) | `package.json` scripts |

**Baseline run (2026-11-22, Node 24.15.0, Windows 11):** `npm test` → 5/5 pass. `npx tsc --noEmit` → exit 0. The emulator integration suite was **not run** because it needs Java 21 and the Firebase CLI.

## 2. Financial capabilities that already work

- Integer centimes for every amount (`lib/model.ts:88` `toCents`, `functions/core.mjs:13` `cents`).
- Oldest-first payment allocation across a client's open debts, with deterministic tie-breaks (`functions/core.mjs:63` `allocate`).
- Overpayment rejection (`functions/core.mjs:80`, `functions/index.mjs` "overpayment").
- Idempotent financial commands: `operations/{requestId}` receipt checked inside the transaction (`functions/index.mjs`, "saveDebt/deleteDebt/savePayment" block).
- Payment serialization per client through the transaction on the client document.
- Audit entries for debt edits and deletes (`audit` collection writes).
- Debt edits cannot go below the amount already paid (`functions/core.mjs:50` `debtValues`, "paidLimit").
- A deleted unpaid debt is voided (`deletedAt`) and reverses its totals. A deleted debt with payments is archived, and its balances are kept.
- Clients with a balance cannot be archived ("archiveBalance").
- Reminder history is recorded as `composer_opened`, never as "delivered" (`functions/index.mjs`, `recordReminder`). This is the honest status model Nsalek keeps.
- The reminder balance is revalidated before a reminder is recorded ("balanceChanged").
- CSV export uses a UTF-8 BOM and guards against formula injection (`app/ui/Views.tsx:1190-1229`).
- Printable account statement through the browser print dialog, with the selected direction and language (`app/ui/Views.tsx:808`, print CSS `app/globals.css:1510+`).
- French/Arabic dictionaries with RTL, and light/dark/system themes (`lib/i18n.ts`, `app/ui/Agrovet.tsx:84-101`).
- Server-side prefix search tokens with accent stripping (`functions/core.mjs:84` `searchTokens`).
- WebMCP tool `start_agrovet_debt` that only opens the form and never saves (`app/ui/Agrovet.tsx:137`).

## 3. Veterinary assumptions that block general use

| Assumption | Where | Effect |
|---|---|---|
| Species enum `sheep/goat/cow/camel` is mandatory on every debt | `functions/core.mjs:30`, `lib/model.ts:2` | A general debt cannot be recorded |
| At least one medicine is required per debt | `functions/core.mjs:33` (`min(1)`) | Same |
| Debt total = unit price per animal × animal quantity | `functions/core.mjs:52` | A plain amount cannot be entered |
| Phone is mandatory and must be an Algerian mobile number | `functions/core.mjs:18`, `app/ui/Editor.tsx:142` | Landlines, foreign numbers and name-only contacts are rejected |
| One fixed clinic id `agrovet` | `functions/index.mjs:24`, `lib/firestoreApi.ts:44` | No workspaces |
| Clinic identity and the doctor's name are hard-coded in SMS text and statements | `lib/clinic.ts`, `lib/model.ts:101` `smsText` | — |
| One direction only (the clinic is owed) | whole model | No payables |
| One currency (DA) | `lib/model.ts:84` `money` | — |
| `reminderDate` acts as both the follow-up date and the implied due date | `functions/core.mjs:35` | A due date and a reminder date are different concepts |
| Medicine catalog and species reports | `functions/core.mjs:99` `periodStats` | Clinic-only reporting |

## 4. Bugs and untested financial assumptions

1. **Security regression in uncommitted work (high).** The working-tree `firestore.rules` replaces the membership check and the "no direct writes" rule with `allow read, write: if request.auth != null` on `clinics/agrovet/**`. `lib/firebase.ts` now sends every financial action to client-side transactions (`lib/firestoreApi.ts`). If deployed, any signed-in Firebase Auth user, including one who self-registers when the Email/Password provider allows sign-up, could read or rewrite all clinic balances, payments and audit entries. Validation and the "server-only writes" guarantee then become advisory. **Recommendation:** do not deploy these rules. Keep the committed callable-function path, or reinstate the `member()` check together with field-level validation.
2. Status functions disagree: `functions/core.mjs:47` uses `paid === total`, while `lib/model.ts:99` uses `paid >= total`.
3. The overpayment pre-check uses the cached `client.balance`. Allocation reads at most 400 open debts (`limit(400)`). A client with more than 400 open debts gets a false "overpayment" error even when the balance allows the payment.
4. A posted debt edit overwrites the amount in place. The audit keeps `before`/`after`, but no reversal/replacement entry exists.
5. Payments cannot be reversed or corrected. A mistaken payment can only be fixed by editing debts.
6. Client and clinic totals are cached counters (`totalDebt`, `balance`, `openDebts`). No reconciliation job recomputes them from the debt and payment records.
7. "Delete client" (uncommitted, `functions/index.mjs` `deleteClient`) archives debts that have payments. The debt stays financially active but is hidden from the default UI lists. Hiding a row must not be mistaken for removing a debt; the importer treats archived debts as live.
8. Reports and statements cap detail at 1,000 records (`functions/index.mjs`, `report`). This is documented and the statement refuses to print, but it is a hard limit.
9. Dates come from `Africa/Algiers` on the server. The uncommitted client implementation uses the device clock (`lib/firestoreApi.ts`, `today()`).
10. Test coverage: 5 unit tests (`functions/test/core.test.mjs`) and 12 emulator checks. Nothing covers payment reversal, multi-currency, payables or concurrent allocation outside the emulator.

## 5. Data and privacy observations

- `.env.local` holds the clinic's Firebase web configuration. It is public app identification, not a secret, but it points at the **live clinic project**. Nsalek copies none of it.
- Debt records carry animal species, quantities and medicine names, which is clinical information. Client `notes` are free text and may contain anything.
- The demo data (`lib/demo.ts`) is synthetic. Nsalek uses its own synthetic demo data.

## 6. Conclusion for Nsalek

Reuse the financial discipline: integer minor units, idempotent commands, transactional allocation, honest reminder statuses, the audit trail, the formula-safe CSV export, print-based statements and FR/AR RTL. Replace the veterinary model with a general party/obligation/payment/allocation core. Run it **local-first** in IndexedDB, so Nsalek works without an account and cannot reach the live clinic database. Isolate veterinary data in an optional extension that the legacy importer fills only on explicit opt-in.

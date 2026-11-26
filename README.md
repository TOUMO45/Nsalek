# Nsalek · نسالك

A local-first debt notebook for individuals, shopkeepers, freelancers, tradespeople and small businesses. Default market Algeria: Arabic (RTL) and French, plus English; DZD, `Africa/Algiers`.

"Nsalek / نسالك" is a **working name**. It is a configurable placeholder (`lib/brand.ts`, `NEXT_PUBLIC_BRAND_NAME*`) and has not been checked for trademark availability.

Nsalek is a separate product derived from the Agrovet/Vetna veterinary clinic debt app. It never connects to the clinic's Firebase project. Optional accounts use Nsalek's own project; without an account nothing leaves the phone. See `docs/current-app-audit.md` and `docs/feature-mapping.md`.

## What it does

- **ليك / عليك kept apart.** What others owe you and what you owe are totaled separately per currency. A per-person net figure is display-only, and netting is an explicit, reversible operation.
- **Fast entry.** Person + direction + amount is enough. Due date, description, reference, follow-up date, tags, attachments, installments and drafts are optional.
- **Repayments.** Allocated oldest-due-first with a preview, and you can adjust the allocation by hand. Overpayment is rejected unless you explicitly record the excess as an advance.
- **Corrections are auditable.** Posted amounts are never overwritten. Corrections use adjustments (increase, decrease, waiver, write-off), void, void + replace, or payment reversal, each with a reason. Every change goes in an append-only audit log.
- **Collections.** Aging buckets, overdue list, due this week, promises to pay (they never reduce a debt), snooze, dispute pause, and a guided reminder queue that opens WhatsApp/SMS/email for you to review. Statuses are honest: prepared → opened for sharing → marked sent. Nothing is ever marked "delivered".
- **Installments** (weekly/monthly, the last one absorbs rounding, end-of-month anchoring, reschedule history) and **recurring debts** (one obligation per period, replay-safe).
- **Business mode.** Invoices with lines, discounts and taxes only when configured. Posting creates exactly one receivable. Also payment receipts and multiple workspaces.
- **Statements.** Printable Arabic RTL and French LTR statements, saved to PDF through the browser's print dialog, with the bundled IBM Plex Sans Arabic font, opening/closing balances and repeated table headers.
- **Data.** CSV export with formula-injection protection; CSV import with dry run, duplicate/replay detection and reversible batches; an explicit Agrovet JSON importer with reconciliation.
- **Backups.** Versioned and checked with sha256, optionally encrypted (WebCrypto PBKDF2 + AES-GCM). Restore is validated in temporary storage first and keeps a pre-restore snapshot. You choose merge or replace, and restoring twice never double-counts.
- **Shop tools.** A cash book (sales, expenses, cash at hand; cash repayments counted by themselves), contacts from a .vcf file or the phone's picker, a balance link a customer opens without any server, and a staff mode where an employee records but cannot correct or cancel (enforced by the command engine).
- **Google Drive copy (optional).** A second copy, photos included, in a hidden folder of the person's own Google Drive; put back on a new phone from the first screen (`lib/drive/`, D39).
- **Account (optional).** Google or email sign-in, automatic cloud copy after each change, return on a new phone, older copies, two phones combined without losing an entry (`docs/cloud-design.md`).
- **Privacy.** PIN privacy lock (not encryption), hide-amounts toggle, generic notification text. No analytics; no network calls without an account.

## Run locally

Requires Node ≥ 22.18 (tested on 24.15).

```sh
npm install
npm run dev          # http://127.0.0.1:3100
npm run build        # static export in out/
npm start            # serves out/ on http://127.0.0.1:3200 (local review only)
npm run dev:cloud    # the app with accounts, on local Firebase emulators (needs Java 21)
```

## Checks

```sh
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # node --test, all tests in tests/
npm run test:cloud   # accounts, rules and cloud copy against the Firebase emulators
npm run bench        # 1,000 people / 50,000 movements (see docs/performance.md)
npm run check        # typecheck + lint + test + build
```

## Layout

| Path | Contents |
|---|---|
| `lib/core/` | Framework-free financial core: types, money parsing/formatting, ledger derivations, command engine, collections, installments, recurrence, invoices, reports, backup/restore, CSV, crypto wrappers |
| `lib/storage/idb.ts` | IndexedDB implementation of the transactional store |
| `lib/cloud/` | Cloud copy: bundle, three-way comparison, decisions (`sync.ts`, knows nothing about Firebase), Firebase, timing |
| `lib/migration/agrovet.ts` | Optional legacy importer for clinic exports |
| `lib/ui/` | React state, components, dictionaries (ar/fr/en) |
| `app/` | Next.js 16 static-export app (hash routing), sample statement page |
| `tests/` | Financial fixtures A–L and everything else (`node --test`) |
| `docs/` | Audit, mapping, plan, decisions, migration, performance, capabilities, help, release checklist |

## Documentation

- `docs/current-app-audit.md`: findings on the clinic app, with file references
- `docs/feature-mapping.md`: clinic feature → keep / generalize / isolate / repair
- `docs/implementation-plan.md` and `docs/decisions.md`
- `docs/cloud-design.md`, `docs/cloud-activation.md`: accounts and cloud copy; how to switch them on
- `docs/migration.md`: Agrovet import, reconciliation, rollback
- `docs/capabilities.md`: storage, backup/restore, notifications, offline: what works and what does not
- `docs/performance.md`: measured numbers and environment
- `docs/help-ar.md`, `docs/help-fr.md`: short usage help
- `docs/release-checklist.md`: working / configured-but-unverified / blocked / deferred

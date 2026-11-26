# Release checklist and status

Status as of 2026-11-22. Each item is in exactly one category:
- **Working:** implemented and verified by the stated check.
- **Configured, not device-verified:** implemented, but it needs a real phone or a browser that the checks here could not run.
- **Blocked by provider:** needs an external provider or account that does not exist.
- **Deferred:** not built in this version.

## Verification commands (run on Windows 11, Node 24.15.0)

| Command | Result |
|---|---|
| `npm test` | All suites pass (fixtures A–L, money/dates/phones, ledger, storage/backup, CSV, migration, regressions). Final count is in the delivery report. |
| `npm run typecheck` | exit 0 |
| `npm run lint` | 0 problems |
| `npm run build` | static export: `/`, `/sample-statement` |
| `node scripts/bench.ts --full-restore` | see `docs/performance.md` (after-fix section) |
| Baseline of the clinic repo (`B:\Desktop\konashi_veto`) | `npm test` 5/5 pass, `tsc --noEmit` exit 0. Emulator integration suite **not run** (needs Java 21 and the Firebase CLI). |

## Working

| Area | Evidence |
|---|---|
| Fixtures A–L (balances, two directions, explicit netting, installments rounding, idempotent retry, reversal, overpayment/advance, currencies separate, settled debts leave queues, recurrence once per period, invoice + payment no double count, concurrent allocations) | `tests/fixtures.test.ts`. L also runs on the IndexedDB adapter (`tests/storage.test.ts`). |
| Amount input: Arabic/Latin digits, separators, ambiguity rejection, number-word rejection, calculator without `eval`, centime unit with confirmation | `tests/money.test.ts`; browser: `1,500` rejected with a message and Save disabled |
| Transactional local persistence, rollback on failure, idempotency across restart | `tests/storage.test.ts` (fake-indexeddb); browser: a debt saved, the page reloaded, and the IndexedDB counts confirmed |
| Corrections (adjust, void, replace, reverse), drafts, credit-limit override, merge, archive | `tests/ledger.test.ts` |
| Statements: opening + movements = closing = derived outstanding | `tests/ledger.test.ts`; PDFs `docs/evidence/sample-statement-ar.pdf` and `-fr.pdf` (3 pages each, Arabic shaping correct, header repeated per page, bundled font) |
| Collections: aging bounds, promises never reduce a debt, dispute/snooze pause, frequency cap, honest reminder statuses | `tests/ledger.test.ts`; browser: queue with 3 people, disputed excluded |
| Backup: manifest, sha256, AES-GCM, wrong passphrase, tamper detection, pre-restore snapshot, merge twice = no double count, workspace-scoped backup | `tests/storage.test.ts` |
| CSV export (formula guard) and import (mapping, encodings, delimiter, dry run, duplicates, replay refusal, reversal) | `tests/csv.test.ts`, `tests/regressions.test.ts` |
| Agrovet importer: reconciliation, no medical data by default, opening balances, reversal | `tests/migration.test.ts` (synthetic fixture) |
| Multi-workspace isolation (commands, exports, backups) | `tests/fixtures.test.ts`, `tests/csv.test.ts`, `tests/storage.test.ts` |
| UI: onboarding, Home ليك/عليك, People (mobile list + desktop table), person page with timeline/running balance, quick add, repayment with allocation preview, Due tabs, reminder composer, statement page, PIN lock, hide amounts, AR RTL + FR LTR, dark and light | Browser walk-through at 375×812 and 1280×800 (screenshots taken during the session) |
| Search by name, normalized phone (incl. local prefix), amount, reference | `tests/ledger.test.ts`, `tests/regressions.test.ts`; browser |
| Performance at 1,000 people / 50,000 movements (Node) | `docs/performance.md` |

## Configured, not device-verified

| Item | Why it is not verified |
|---|---|
| Offline app shell (service worker `public/sw.js`) | Registration failed inside the Claude desktop app's embedded browser. The headless Edge check was inconclusive. Test on Chrome desktop and Android: install, go offline, reopen. |
| Local notifications (generic, once a day, when the app opens) | The embedded browser denies the permission. Needs a real browser with notifications allowed. |
| Persistent-storage request and quota display | Behavior differs between browsers. Not observed in a real Chrome/Safari profile. |
| Backup download / file restore through the UI | The download and file-picker steps were not driven in the browser pane. The same code path is covered end to end by `tests/storage.test.ts`. |
| CSV import/export and Agrovet import screens | The UI was not driven with real files. The logic is covered by tests. |
| WhatsApp/SMS/email composers | URLs are built and the reminder is logged. Opening the external apps needs a phone. |
| Real browser IndexedDB speed at 50k movements, phone memory during a 67–90 MB backup | Only measured in Node (see `docs/performance.md` → Pending). |
| PWA install with the generated icons (`icon.svg`, `icon-192.png`, `icon-512.png`) | Icons render (checked visually); "Add to home screen" was not tried on a device. |
| Usability targets (first debt within ~1 min, repeat entry within ~10 s, users can explain owe vs owed) | Not tested with people. An automated walk-through took ~9 s for a first debt, which is **not** a user test. Pending: one personal user, one shopkeeper, one service provider. |

| One-tap backup through a real share sheet; restore of a file received from Drive or WhatsApp | Simulated only. Try on Android Chrome and iPhone Safari. |
| Voice entry with a real microphone, in Darija | Recognition was simulated; the rules are tested (`tests/voice.test.ts`). Real Darija accuracy of `ar-DZ` is **unknown**: record 50 real sentences per speaker and count wrong saves (target: 0). |

| Accounts and cloud copy on the **live** project | Built and tested on emulators (2026-11-25): engine, rules, screens, two browsers side by side. Not yet switched on. Afterwards: Google sign-in in Chrome, Safari and the installed app; reset and confirmation emails (spam folder); a real second phone; a real weak network. Steps: `docs/cloud-activation.md`. |

## Blocked by provider (needs configuration and authorization)

- Automated SMS/WhatsApp/email delivery (requires an official provider, consent, cost disclosure, delivery webhooks).
- Team accounts (several people with different rights on one notebook).
- Payments, subscriptions, app-store releases.

## Deferred (P2)

- Live sync between phones (record by record). Today: a whole copy, combined within minutes.
- Photos in the cloud copy.
- Team roles (owner/operator/read-only), customer read-only links.
- AI/OCR input. Voice entry exists (D26–D28) without any AI provider of ours.
- Cross-currency settlement and converted dashboard estimates.
- XLSX export (CSV only, by design).
- Native mobile wrappers, biometric unlock.

## Before any public release

1. Run the "Configured, not device-verified" checks on real devices and record the results here.
2. Test install and offline reopen with the manifest and icons.
3. Run usability sessions and record the outcomes.
4. Trademark check for the final name (Nsalek is a placeholder).
5. Decide hosting. The app is a static site; any HTTPS static host works. **Do not deploy without explicit authorization.**
6. If anyone imports real clinic data: export read-only, dry run, review the reconciliation report, keep a backup, and only then commit (`docs/migration.md`).

## Known limitations

- Without an account, data lives in one browser profile and moves only by backup files.
- A cloud copy that was never made cannot come back: an entry made offline on a phone that is then lost is lost.
- Statement PDFs depend on the browser's print engine. They were verified with Microsoft Edge (Chromium) only.
- `canonical()` makes large unencrypted backups slower to open than encrypted ones (see `docs/performance.md`).
- Payment method labels are notes, not bank integrations. Payment proofs are attachments, never automatic confirmation.
- Invoices are simple commercial documents, not certified tax invoices.

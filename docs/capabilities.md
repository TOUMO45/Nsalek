# Capabilities: storage, backup, notifications, offline

This page states what the current build actually does on each platform, and what it does not.

## Storage

| Item | Behavior |
|---|---|
| System of record | IndexedDB database `nsalek` (version 1) in the browser profile. Every financial command runs in **one read-write transaction** covering all stores. "Saved" appears only after the transaction's `complete` event. |
| Failure handling | A failing command (validation, quota, I/O) aborts the whole transaction; nothing partial is written, and the form keeps its input and shows the error. Covered by tests: `tests/storage.test.ts` ("a failing command rolls back every write") and `tests/ledger.test.ts` ("storage failure leaves data unchanged"). |
| Concurrency | The browser serializes overlapping read-write transactions, including across tabs, so two payments cannot both allocate the same remaining amount (fixture L, tested on the IndexedDB adapter). Other tabs reload when a `BroadcastChannel` message arrives. |
| Idempotency | Each form creates a command id once. A retry or double tap returns the first result (fixture E, also across restart). |
| Durability risk | Browsers can delete site data when the user clears it, in private windows, or under storage pressure. The app shows the persistent-storage status and can request it (`navigator.storage.persist()`), but **browser storage can still be lost**. Keep backups off the device. |
| Schema upgrades | `lib/storage/idb.ts` `upgrade()` is versioned and additive only. |

## Backup and restore

| Item | Behavior |
|---|---|
| Format | JSON `nsalek-backup`, `schemaVersion` 1: manifest with per-store counts, per-workspace/currency totals (receivable, payable, advances), sha256 of the canonical payload, attachment count and bytes, encryption metadata. |
| Attachments | Included inside the backup (base64). Nothing is omitted; `manifest.attachments.omitted` is empty. |
| Encryption | Optional. PBKDF2-SHA-256 (310,000 iterations) → AES-GCM-256 via WebCrypto. The passphrase is not stored anywhere. **A forgotten passphrase makes the backup unrecoverable.** A wrong passphrase or a modified file fails authentication. |
| Scope | This workspace or all workspaces. A workspace-scoped backup contains no other workspace's records (tested). |
| Restore safety | 1) parse and check the version; 2) decrypt; 3) verify sha256; 4) load into a **temporary in-memory store**; 5) validate referential and financial invariants; 6) compare counts and totals with the manifest; 7) snapshot current data (kept in the `snapshots` store, downloadable); 8) apply in one transaction. Any failure in steps 1–6 leaves active data untouched (tested with a tampered file). |
| Merge vs replace | The user chooses. Merge adds unknown ids, skips identical records and reports conflicts without overwriting, so restoring the same file twice adds nothing (tested). Replace clears and rewrites in one transaction. |
| Automatic backups | **Not implemented.** Browsers cannot write files in the background. The home screen warns when there is no backup or the last one is more than 7 days old. |
| Backup status | "Last backup" records when a backup file was **generated and handed to the browser's download**. The app cannot confirm that the file reached a safe location. |

## Notifications and reminders

Three mechanisms, kept separate:

1. **Local owner notifications.** If the user enables them (permission prompt), the app shows one **generic** notification per day ("You have N items to follow up today", no names or amounts) **when the app is opened or brought back** outside quiet hours. **There is no closed-app, scheduled or after-reboot delivery** on the web. Notification Triggers are not a shipped standard, and Periodic Background Sync is Chromium-only, heuristic and not used. If permission is denied, the in-app Due list still works.
2. **User-reviewed sharing.** WhatsApp (`wa.me`), SMS (`sms:`) and email (`mailto:`) open the person's own app with a draft. The log records `opened_for_sharing` when the composer is opened and `marked_sent` only when the user says so. The outstanding amount is recomputed right before the message is prepared (`balance_changed` otherwise).
3. **Automated provider delivery.** **Not implemented.** The statuses `provider_accepted` and `delivered` exist in the model, but the app refuses to set them (`no_provider_evidence`). No unofficial WhatsApp automation and no bulk sending.

Settling, reversing or rescheduling a debt changes the derived due lists immediately, because no reminder is pre-scheduled that could go stale.

## Offline

| Item | Status |
|---|---|
| Recording, repayments, statements, backups, CSV while offline | Work: everything runs locally once the app is loaded. |
| Reopening the app with no network | A service worker (`public/sw.js`) caches the app shell. **Not verified:** registration failed inside the Claude desktop app's embedded browser ("unknown error when fetching the script"), and a headless Edge check was inconclusive. It needs checking on a real Chrome or Android install. |
| Sync | None. There is nothing to reconnect, so "appears exactly once after reconnect" does not apply in this version. |

## Security notes

- The PIN lock is a privacy screen stored as a salted PBKDF2 hash. **It does not encrypt data at rest.**
- The app makes no network requests for data. It has no analytics or crash reporting, and logs no amounts or names.
- `NEXT_PUBLIC_*` variables are public. None is a secret (`.env.example`).

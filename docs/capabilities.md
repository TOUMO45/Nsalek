# Capabilities: storage, backup, notifications, offline

This page states what the current build actually does on each platform, and what it does not.

## Storage

| Item | Behavior |
|---|---|
| System of record | IndexedDB database `nsalek` (version 2: the cash book) in the browser profile. Every financial command runs in **one read-write transaction** covering all stores. "Saved" appears only after the transaction's `complete` event. |
| Failure handling | A failing command (validation, quota, I/O) aborts the whole transaction; nothing partial is written, and the form keeps its input and shows the error. Covered by tests: `tests/storage.test.ts` ("a failing command rolls back every write") and `tests/ledger.test.ts` ("storage failure leaves data unchanged"). |
| Concurrency | The browser serializes overlapping read-write transactions, including across tabs, so two payments cannot both allocate the same remaining amount (fixture L, tested on the IndexedDB adapter). Other tabs reload when a `BroadcastChannel` message arrives. |
| Idempotency | Each form creates a command id once. A retry or double tap returns the first result (fixture E, also across restart). |
| Durability risk | Browsers can delete site data when the user clears it, in private windows, or under storage pressure. The app shows the persistent-storage status and can request it (`navigator.storage.persist()`), but **browser storage can still be lost**. Keep backups off the device. |
| Schema upgrades | `lib/storage/idb.ts` `upgrade()` is versioned and additive only. Version 2 adds the `cashEntries` store; a version-1 database with data was upgraded in a test (`tests/cash.test.ts`) and in the browser, nothing lost. Backups and copies are format 2; an older app refuses them (`newer_schema`) instead of dropping the cash book, and format-1 files still open. |

## Backup and restore

| Item | Behavior |
|---|---|
| Format | JSON `nsalek-backup`, `schemaVersion` 1: manifest with per-store counts, per-workspace/currency totals (receivable, payable, advances), sha256 of the canonical payload, attachment count and bytes, encryption metadata. |
| Attachments | Included inside the backup (base64). Nothing is omitted; `manifest.attachments.omitted` is empty. |
| Encryption | Optional. PBKDF2-SHA-256 (310,000 iterations) → AES-GCM-256 via WebCrypto. The passphrase is not stored anywhere. **A forgotten passphrase makes the backup unrecoverable.** A wrong passphrase or a modified file fails authentication. |
| Scope | This workspace or all workspaces. A workspace-scoped backup contains no other workspace's records (tested). |
| Restore safety | 1) parse and check the version; 2) decrypt; 3) verify sha256; 4) load into a **temporary in-memory store**; 5) validate referential and financial invariants; 6) compare counts and totals with the manifest; 7) snapshot current data (kept in the `snapshots` store, downloadable); 8) apply in one transaction. Any failure in steps 1–6 leaves active data untouched (tested with a tampered file). |
| Merge vs replace | The user chooses. Merge adds unknown ids, skips identical records and reports conflicts without overwriting, so restoring the same file twice adds nothing (tested). Replace clears and rewrites in one transaction. |
| One-tap backup | One encrypted file with every real notebook, handed to the phone's share sheet (Drive, WhatsApp, e-mail) or saved. Verified as restorable before it counts. Share sheets were simulated in tests and in the browser pane; **not tried on a phone.** |
| Automatic backups | With an account, the cloud copy (below). Backup **files** are never made automatically: browsers cannot write files in the background. The home screen warns from the number of unsaved changes and their age (decision D25). |
| Backup status | "Last backup" records when a backup file was **generated and handed to the browser's download**. The app cannot confirm that the file reached a safe location. |

## Copy in the person's own Google Drive

Off in a build without `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. Code: `lib/drive/`; decision D39.

| Item | Behavior |
|---|---|
| Where | Google's hidden app folder in the person's own Drive. Nsalek sees only that folder; it counts in the person's Google storage. The operator never receives it. |
| What | Every real notebook, **photos included**, in the backup format, gzip, sha256 of the file in its labels. Not the demo notebook. An empty notebook is never sent. A notebook that breaks a ledger rule is not sent. |
| When | While Google's permission lasts (about an hour, kept in memory only): 90 s after the last change, at most every 10 minutes, and when the app is left. After the hour, or after reopening the app, a tap on "Copy now" asks Google again. After an error, 10 minutes before trying again; a full storage, a refusal or an inconsistent notebook waits for the person. |
| Kept | Per phone: newest 3, one a day for 7 days, a week for 4, a month for 6. Whatever its age, each loss: when the phone no longer holds an audit event, a photo or a notebook of the previous copy (a restore over the notebook, a photo removed, a notebook removed), the new copy names it in its own labels, in the same request, and both are kept (newest 40). Always the copy with the most records, the one with the most photos, and the newest copy of each notebook (about 20 notebooks fit in the labels). A phone never removes another phone's copies, nor any file that is not a Nsalek copy. Nothing is removed before the new copy is in Drive with the right size and fingerprint. A phone clock set back can hide a loss from this check. |
| Putting back | The list shows date, phone, people, entries, photos and size; a copy is downloaded, its fingerprint checked, then the same checked restore as a file (merge or replace, snapshot first). On a new phone: "Restore from Google Drive" on the first screen. |
| Full storage | Google's answer is shown in words: free space or buy storage from Google, then "Copy now". Nothing is removed meanwhile. |
| Verified | With a fake Drive (tests and the browser); reviewed twice by an independent agent, every finding reproduced and fixed with a test. **Not verified:** Google's window, the real Drive API, uploads above 4 MB (two steps), revoking on "Stop", Google's app check. |

## Accounts and the cloud copy

Design, dangers and their answers: `docs/cloud-design.md`. Off in a build without `NEXT_PUBLIC_FIREBASE_*`.

| Item | Behavior |
|---|---|
| Sign-in | Google, or email and password; password reset and address confirmation by email. Optional: everything works without it. Tried on the Firebase **emulators** only; Google sign-in, real emails and real phones are **not verified**. |
| When it saves | About 4 s after the last change, at most every 15 s; when the app is opened, comes back, is left, or the network returns; every 5 minutes while open. Nothing runs while the app is closed. |
| What is saved | Every real notebook, whole, in the backup format, gzip, sha256. **Not** photos, the demo notebook, the PIN, the backup key or settings. |
| How it is saved | One Firestore transaction: all of it or nothing, only on top of the copy this phone knows (checked by the app and by `firestore.rules`). A lost answer is recognised afterwards. |
| New phone | Signing in on an empty phone brings everything back, after the sha256 and the ledger rules were checked. An empty phone is never sent over a full copy. |
| Two phones | While both are open, a phone hears within seconds that the other saved (a listener on the account's head document: one read when it starts and one per change; emulator test), then fetches and combines. Different records are combined by themselves. The same record changed differently, or a result that breaks a rule (overpaid debt, correction of a cancelled debt), is asked, for the whole notebook; the copy not chosen is kept. A repeated receipt number or imported line is asked too, and both can be kept. Not live: up to 5 minutes, or at opening. |
| Older copies | Newest 3, 7 days, 4 weeks, 6 months, 10 pinned. Going back saves the present state first. |
| Leaving | Sign out and keep, sign out and remove (refused until everything is saved), delete the account with every copy (the notebook stays on the phone). |
| Privacy | Encrypted in transit and at rest by Google, readable only by the account (rules), **but not end-to-end**: the operator can technically read it. Said before the first sign-in. |
| Limits | 8.5 MB compressed per notebook set. Free plan: 20,000 writes and 50,000 reads a day, 1 GiB in all; beyond it the app says so and keeps everything on the phone. |

## Shop tools

| Item | Behavior |
|---|---|
| Cash book | Money in and out of the drawer that is not a debt: opening cash, cash sales, other income, money put in; expenses, stock purchases, money taken out. Repayments of debts made in cash appear by themselves (never typed twice); other ways of paying stay out. Day view, cash at hand at the end of the day (shown with a minus when the drawer is short), month by kind and by label, CSV export. An entry is never edited: it is cancelled with a reason and stays visible. Integer minor units; tested (`tests/cash.test.ts`). |
| Contacts | From a .vcf file (any phone's contacts app exports one; vCard 2.1/3.0/4.0, Arabic in quoted-printable) or the browser's contact picker where it exists (Chrome on Android, so also the Android app). Shown first, people already in the notebook (same name or number) are not added again, nameless contacts are not added. Nothing is sent anywhere. Picker **not tried on a phone**. |
| Balance link | A link that shows one person their balance and latest lines (20, or 12 in a reminder). The figures are inside the link after `#`, which the browser never sends to a server; it is a picture of one day, not a live view; anyone with the link can see it. The viewer accepts only a well-formed snapshot (whole minor units, bounded sizes). From the person's page, and as an option in reminders. |
| Staff mode | The owner hands the phone to an employee (an owner PIN is required). Staff record people, debts, repayments, cash, promises, reminders, notes and photos; corrections, cancellations, merges, imports, settings, backups, accounts and notebooks are refused **by the command engine**, which reads staff mode inside each transaction, not only by the screens. Totals are hidden; the audit log marks staff entries; leaving needs the owner's PIN; reloading does not leave it. It guards against mistakes and curiosity on a shared phone, not against someone who takes the phone apart. Staff on **their own phones** (shared notebooks) is **not built**. |

## Notifications and reminders

Three mechanisms, kept separate:

1. **Local owner notifications.** If the user enables them (permission prompt), the app shows one **generic** notification per day ("You have N items to follow up today", no names or amounts) **when the app is opened or brought back** outside quiet hours. **There is no closed-app, scheduled or after-reboot delivery** on the web. Notification Triggers are not a shipped standard, and Periodic Background Sync is Chromium-only, heuristic and not used. If permission is denied, the in-app Due list still works.
2. **User-reviewed sharing.** WhatsApp (`wa.me`), SMS (`sms:`) and email (`mailto:`) open the person's own app with a draft. The log records `opened_for_sharing` when the composer is opened and `marked_sent` only when the user says so. The outstanding amount is recomputed right before the message is prepared (`balance_changed` otherwise).
3. **Automated provider delivery.** **Not implemented**, on purpose: it needs a server and a paid SMS or WhatsApp Business service, and the brief forbids sending reminders to customers. A reminder can carry the person's balance link. The statuses `provider_accepted` and `delivered` exist in the model, but the app refuses to set them (`no_provider_evidence`). No unofficial WhatsApp automation and no bulk sending.

Settling, reversing or rescheduling a debt changes the derived due lists immediately, because no reminder is pre-scheduled that could go stale.

## Offline

| Item | Status |
|---|---|
| Recording, repayments, statements, backups, CSV while offline | Work: everything runs locally once the app is loaded. |
| Reopening the app with no network | A service worker (`public/sw.js`) caches the app shell. **Not verified:** registration failed inside the Claude desktop app's embedded browser ("unknown error when fetching the script"), and a headless Edge check was inconclusive. It needs checking on a real Chrome or Android install. |
| Sync | With an account: entries made offline are kept on the phone and sent when the network returns, exactly once (`tests/cloud.test.ts`). Without an account there is none. |

## Security notes

- The PIN lock is a privacy screen stored as a salted PBKDF2 hash. **It does not encrypt data at rest.**
- Voice entry, if the user agrees to it, makes the **browser** send the recorded audio to its maker (Google, Apple or Microsoft) to turn it into text. The app itself receives only the text. Without that consent nothing is recorded.
- Without an account the app makes no network requests for data. With one it talks only to Google's sign-in and Firestore (the published Content-Security-Policy allows nothing else). It has no analytics or crash reporting, and logs no amounts or names.
- `NEXT_PUBLIC_*` variables are public, the Firebase web key included. None is a secret (`.env.example`); access is decided by `firestore.rules`.

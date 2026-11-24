# Nsalek: feature-by-feature test report

**Date:** 2026-11-23
**Build tested:** production static build of commit `94479f4`, served locally on 127.0.0.1. No hosting or deployment was involved.

**How it was tested:**
- Automated checks: `npm run check`.
- A manual walk-through of every screen in the Claude desktop app's built-in browser, at 1024×768 and 375×812, in French, Arabic and English, in dark and light themes.
- The offline test ran in an isolated headless Microsoft Edge with a throwaway profile. The profile was deleted afterwards.

**Verdict:** the money engine is solid and every calculation checked was correct. Before real users, it needs 4 important fixes, about 10 medium fixes and some polish.

## 1. Automated checks

| Check | Result |
|---|---|
| `tsc --noEmit` | pass |
| `eslint` | pass |
| `node --test` | **82 / 82 pass** |
| `next build` (static export) | pass |

## 2. What was tested by hand and worked

Each line was checked on screen. Where an amount is given, it was checked against a hand calculation.

| Area | What was checked | Result |
|---|---|---|
| Onboarding | Language choice, personal/business mode, notebook name, demo notebook | OK |
| Amount entry | `1,500` is rejected with a clear message and Save is disabled. Arabic digits ٧٥٠٠ are accepted. Calculator: `1000+1500` gives 2 500,00 DA. Pressing Enter saves | OK |
| Debts: "On me doit" and "Je dois" | The two directions are always kept apart. Optional fields: due date (+7/+30), reference, follow-up, tags, attachment, draft | OK |
| Installments | 12 000 DA in 7 payments: 6 × 1 714,28 + 1 714,32 = 12 000,00 | OK |
| Repayment allocation | 4 000 DA goes to the oldest debt first (2 500 + 1 500). The preview matches the saved result | OK |
| Overpayment | Blocked unless the excess is explicitly recorded as an advance. The advance is shown separately | OK |
| Apply advance | 2 000 DA of a 3 000 DA advance applied to a new debt. 1 000 DA remains | OK |
| Payment reversal | Requires a reason. The debt reopens and the payment stays in history marked "Annulé" | OK |
| Adjustments | Discount, write-off, decrease and increase. A reduction larger than the amount due is refused | OK |
| Replace / void | The old entry is kept as "Annulée" with its history. The new entry and totals are correct | OK |
| Search | By name, phone (`+213…` and `0661…`), amount and reference | OK |
| Duplicate person | Same phone in a different format is detected. The user can choose "use existing" or "create anyway" | OK |
| Merge | Debts moved, total 2 300 + 500 = 2 800. Self-merge is blocked in the core | OK |
| Archive / restore | Warns when the person still owes money. Debts stay in the totals | OK |
| Netting | Indicative net shown first. Explicit offset requires a reason. Both sides reduced by 1 000 | OK |
| Collections | Today / overdue / this week / promises / reminder queue. Aging buckets are correct. A disputed debt leaves "today" | OK |
| Reminders | Pre-written FR/AR text. `wa.me/213661234567` and `sms:+213661234567` links are correct. Status is "Ouvert pour partage", never "delivered". The person leaves the queue after a reminder | OK |
| Snooze | Badge "Suspendu jusqu'au 30/11/2026" | OK |
| Statement | Opening 0 → closing 2 800,00 matches the person page. Both directions shown, advance noted, FR and AR (RTL) | OK |
| Invoices | 10 × 950 at −5 % plus 500 = **9 525,00**. Creates exactly one debt: balance went 2 800 → 12 325 | OK |
| Recurring debts | Start date one month back creates October and November once each. A full page reload creates no duplicates (42 000) | OK |
| Reports | New receivables 21 325, new payables 28 000, received 9 000. Voided entries and reversed payments excluded | OK |
| CSV export | `;` separator, UTF-8 with BOM, voided rows included, formula injection neutralised (`'=1+1`) | OK |
| CSV import | Auto column mapping. Dry run: 2 valid, 1 error, 0 duplicates. Import, then a one-click undo of the whole batch | OK |
| Backup | Encrypted (AES-GCM). Names and phones unreadable in the file | OK (see bug M1) |
| Restore | Wrong passphrase rejected. Correct passphrase gives "✓ Sauvegarde vérifiée". Merging the same data twice leaves totals unchanged. A pre-restore snapshot is kept | OK |
| PIN lock | Wrong PIN rejected, right PIN unlocks. Lock returns after reload. No data left on the page while locked | OK |
| Hide amounts | Every amount becomes `•••••` | OK |
| Quick notes | Arabic sentence "ياسين أخذ 3500 دج سلعة" becomes a draft debt, with the person flagged as unconfirmed | OK |
| Notebooks | Demo notebook fully separate. DZD and EUR totals kept separate | OK |
| Languages | Arabic RTL, French, English | OK (see untranslated text) |
| Themes | Dark and light | OK |
| Phone layout 375 px | Bottom navigation with central "+", forms as bottom sheets, no horizontal scrolling | OK |
| Offline after a second visit | App opens with local data while the server is down | OK |

## 3. Bugs, most important first

### Must fix before real users

| # | Bug | Where | What the user sees |
|---|---|---|---|
| H1 | **Offline fails after the first visit.** The worker pre-caches only `/`, the manifest and the icon. The app's JS/CSS is cached only when requested *through* the worker, which does not happen on the first visit. | `public/sw.js:5` | Someone opens the app once, later has no signal, and gets "جارٍ التحميل…" forever. Proven in isolated Edge. |
| H2 | **Cannot invoice, or create a recurring debt for, a new person.** The picker's "Créer « … »" relies on the form creating the person on save. The debt form does this (`app/ui/Forms.tsx:139-140`); the invoice and recurring forms do not. | `app/ui/Business.tsx:210-213`, `:328`; `lib/ui/components.tsx:384` | Buttons stay disabled with no explanation. |
| H3 | **Receipts are recomputed from today's data.** "Reste après" and the per-debt "Reste" use the current balance, not the balance at the time of payment. | `app/ui/Statement.tsx:192`, `:250` | Receipt R-00002 for 9 000 DA showed "Reste après 2 800" although the balance after that payment was 0. Reprinting a receipt later shows different numbers. |
| H4 | **A promise is marked "Tenue" (kept) instantly** when a payment was made earlier the same day. The check compares dates (`p.date >= madeOn`), not times. | `lib/core/collections.ts:96-104` | A new promise is shown as kept although nothing was paid after it. |

### Should fix

| # | Issue | Where |
|---|---|---|
| M1 | The encrypted backup stores **totals in plain text** in its manifest (owed to you, owed by you, advances). Anyone with the file sees the business's position without the passphrase. | `lib/core/backup.ts:83` |
| M2 | **Raw codes shown to users:** `st_posted` on invoices (missing i18n key), CSV import errors such as `amount_ambiguous_separator`, `ok/error/(new)`, the import summary `parties/obligations/payments/allocations`, the backup snapshot "before merge", the reminder channel `whatsapp`/`sms`, and the audit log (action codes and internal IDs instead of names). | `app/ui/Business.tsx:53`, `app/ui/ImportExport.tsx:249`, audit page |
| M3 | Advances are hard to use. The debt form does not mention an available advance. "Affecter l'avance" is a small link inside the Remboursements tab. History shows a 9 000 DA cash payment as **−6 000**, with the 3 000 advance only in the header. | person page |
| M4 | Explicit netting was applied to a **disputed** debt without asking. | netting command |
| M5 | A debt with only a discount (no payment) is labelled **"Partiellement payée"**. | `lib/core/ledger.ts:69` |
| M6 | The report's "Compensation explicite" shows **2 000** for a 1 000 DA offset (both sides added). | `lib/core/reports.ts:65` |
| M7 | Plurals: "**1 personnes**", "**1 أشخاص**". There is a single plural string for every count. | `lib/ui/i18n.ts:35` |
| M8 | Wrong help text under "Masquer les montants": it describes notifications. | `app/ui/More.tsx` (security section) |
| M9 | Native browser `confirm()`/`prompt()` popups for archive, PIN removal and import undo, instead of the app's own dialogs. | several |
| M10 | The PIN has no limit or delay on wrong attempts, so a 4-digit PIN can be guessed by trying. | `app/ui/App.tsx:256-281` |

### Polish

- The ⋯ menu on the person page stays open after you choose an action.
- The merge list includes the person themself, and its placeholder says "type a new name".
- "Annuler" (close) sits next to "Annuler le remboursement" (reverse). Both read as "cancel"; use "Fermer".
- The supplier page offers "Relancer" and "Promesse de paiement", which make no sense for someone you owe.
- "Remboursement reçu" lists people you owe first.
- The apply-advance dialog shows the date as `2026-11-23`.
- At about 800 px wide, the three home quick-action buttons are cramped.
- Leaving a demo notebook deletes it without warning.
- "Cette semaine" empty state says "Rien à suivre aujourd'hui".
- No "resume reminders" option after a snooze.
- The CSV screen says "Delimiter" (English), labels the direction column "Statut", and shows the hint "debt / payment" in English.
- The printed invoice is titled "Factures F-00001" (plural), and the discount sits under the "Prix unitaire" column.
- Accessibility: the direction toggle buttons have no accessible name, and the close button is labelled "close" in every language.
- Unverified: CSV amounts use `.` decimals even in "Excel FR" mode. Check whether French Excel reads them as numbers.

## 4. Not tested, and why

| Item | Why |
|---|---|
| Phone notifications | Need a real device with permission. The embedded browser denies it. |
| WhatsApp/SMS opening on a phone | Links were verified. Opening the apps needs a phone. |
| Install to home screen (PWA) | Needs Chrome or Android on a device. |
| Print / Save as PDF dialog | The earlier session verified the PDFs in Edge. Not repeated. |
| Agrovet import screen with a real export | No real clinic export file was used. The logic is covered by `tests/migration.test.ts`. |
| Speed with 50 000 entries on a phone | Only measured in Node (`docs/performance.md`). |
| Real users | None yet. This remains the most important next test. |

## 5. Fixes made after this report (same day, not committed yet)

All "Must fix" (H1–H4) and "Should fix" (M1–M10) items are fixed. Each logic fix has a regression test in `tests/fixes.test.ts`; each test was seen failing before the fix. `npm run check` passes: 96/96 tests, typecheck, lint and build.

| # | Fix | Verified by |
|---|---|---|
| H1 | `scripts/sw-precache.mjs` runs after `next build` and writes every app-shell file (34) plus a content-hash version into `out/sw.js`. | Test. Isolated headless Edge: offline right after the **first** visit now opens the notebook. |
| H2 | Invoice and recurring forms create a typed new person on save, with the duplicate choice (`useNewParty` in `app/ui/Business.tsx`). | Browser: invoice F-00002 for a new "Épicerie Nour"; recurring rent for a new "Propriétaire local". |
| H3 | `receiptFigures()` rebuilds the figures as they stood when the payment was recorded. | Test. Browser: R-00002 now shows "Reste après 0,00 DA" and "Avance 3 000". |
| H4 | A promise counts only payments recorded after it (`collections.ts`). | Test. Browser: Karim's promise now shows "En attente". |
| M1 | Encrypted backups keep their totals only inside the ciphertext. The restore preview computes them after decryption. | Test and browser. |
| M2 | Readable labels for invoice states, CSV import errors and statuses, record types, reminder channels, snapshots, and every audit action (including the template-built ones). The audit log names the person, debt, receipt or invoice. | Tests that scan the source for every code, plus browser checks in FR/AR/EN. |
| M3 | Debt form offers "use the available advance". Person page has an "Affecter l'avance" button. History shows the full cash amount. An advance applied later is its own entry in time order. | Tests (`advancePayments`, `partyEffects`). Browser: a 400 DA debt paid from the advance. |
| M4 | Netting skips disputed debts. The netting form shows the real limit and says why. | Test. |
| M5 | "Partiellement payée" only when money or an offset came in. | Test. |
| M6 | The report counts one netting once (1 000, not 2 000). | Test and browser. |
| M7 | `peopleCount()`: 1 personne / 2 personnes; شخص واحد / شخصان / 5 أشخاص / 11 شخصاً. | Test and browser. |
| M8 | Correct help text under "Masquer les montants". | Browser. |
| M9 | One in-app dialog (`useAsk`) replaces every `window.confirm` and `window.prompt`. The ⋯ person menu now closes after an action. | Browser: archive, invoice void, restore replace. |
| M10 | Five free tries, then 30 s doubling to 15 min, stored with the PIN so a reload does not reset it. One check at a time, so overlapping tries cannot undercount. | Test. Browser: "Réessayez dans 28 s" after 5 wrong tries, still there after reload. |

The "Polish" list in section 3 is still open, except the ⋯ menu and the "Annuler / Annuler" wording in the new dialogs.

**Correction (2026-11-24):** section 2 said the 375 px layout was fine. It was not in French: the labels of the three home buttons overflowed ("white-space: nowrap" won over the wrap utility) and widened the page to 411 px. Fixed with `.btn-wrap`; the page is 375 px wide again.

## 6. Test environment notes

- **Test notebook:** "Boutique Test" (made-up people) remains in the built-in browser's storage for `localhost:3200`. The test PIN was removed. Delete the notebook in Plus → Carnets, or clear that site's data.
- **Port 3200:** a static server started by the earlier session (`node scripts/serve-static.mjs`, since 2026-11-22) is still running there.
- **graphify:** `graphify update .` created `graphify-out/` in this repo. It is not in `.gitignore`.

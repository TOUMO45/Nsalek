# Test report, 2026-11-26

Branch `feat/accounts-cloud`, after adding the cash book, contacts import, the balance link, staff
mode and faster updates between two phones. Everything below was run on the developer's computer;
nothing was published, and no real phone, real Google service or real customer was involved.

## Automated

| Suite | Result |
|---|---|
| `npm test` (ledger, money, backups, cloud engine, Drive copy, cash book, contacts, balance link, staff mode, voice, CSV, migration, service worker) | 300 / 300 pass |
| `npm run test:cloud` (real Firebase code and security rules on the local emulators, including the new two-phone notice) | 13 / 13 pass |
| `tsc --noEmit`, `eslint .` | 0 problems |
| `npm run build` | static export built; the development-only fake Drive is absent from the output |

## In the browser (development build, desktop Chrome engine, also 375×812 phone size)

| Flow | Checked |
|---|---|
| Database upgrade 1 → 2 on a browser that already had data | opened with every notebook and entry |
| New business notebook, debt with the amount calculator (2500 + 1500) | 4,000 DA saved, totals right |
| Repayment of 5,000 on a 4,000 debt | stopped: offered only as an explicit advance |
| Cash repayment 1,500 | appeared by itself in the cash book; "sold on credit today 4,000" shown |
| Cash sale 12,000, expense 3,000, cancelling the sale with a reason | cancelled line stays visible and stops counting; reason required |
| Balance link from a person's page | 271-character link; the customer's page shows the balance and lines; nothing from other people |
| Staff mode | entering needs an owner PIN; menu limited; owner pages blocked; cancelling refused by the engine; reload keeps staff mode; wrong PIN refused; right PIN leaves; after a restart staff mode opens without the owner's lock |
| Contacts from a .vcf file (3.0 and 2.1 with Arabic) | preview right; existing person and nameless contact not added; 2 added and found by name and number |
| Google Drive copy (fake Drive), accounts (emulators) | earlier the same day; see `docs/capabilities.md` |
| Arabic RTL, French, dark mode, phone width | cash book, contacts, balance link, staff banner |

## Speed with a big shop

300 people, 10,000 debts, 6,000 repayments, 3,000 cash entries, loaded into the app's own database.
Development build on this computer; a cheap phone is expected to be several times slower.

| Step | Time |
|---|---|
| Opening the app until the first screen | about 0.5 s |
| People list / person page / cash book day / search | 87 / 40 / 52 / 14 ms |
| Home totals, today's list, reminder queue (core code, Node) | 10 / 14 / 13 ms |
| Ledger rules check / backup file / Drive copy (Node) | 52 ms / 0.34 s / 1.2 s |

The home total (10,502,150 DA) matched the sum computed by hand.

## Independent reviews

Two agents reviewed the new code without seeing the author's reasoning. Findings fixed the same day,
each with a test where it concerns data: a cash-only notebook treated as empty (could be replaced
or never copied), staff mode needing the owner's PIN at start, cash at hand counting every
repayment since the beginning, a crafted balance link crashing the viewer, "+213 (0)" numbers saved
wrong, a slow contacts plan, Drive copies losing their protection after one failed request, photos
not counted when old copies are thinned out.

## Not verified

Real phones (Android Chrome, iPhone Safari, the installed app), the contact picker, real Google
sign-in and Google Drive, real e-mails, the live Firebase project, the Play Store package, slow
networks, and any real shopkeeper using the app.

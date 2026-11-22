# Importing data from the Agrovet clinic app

The Agrovet importer is optional, explicit and reversible. It turns a JSON export that you supply into Nsalek records. It never connects to Firebase, Firestore or any other database or network service. Code: `lib/migration/agrovet.ts`. Tests: `tests/migration.test.ts`, run against the synthetic fixture `tests/fixtures/agrovet-sample.json`.

**This repository contains no script that reads the live clinic database.** Nsalek holds no clinic credentials and must never be given any.

## 1. Get an export without modifying production

The importer accepts one JSON object shaped like the clinic's `Data` type (`lib/model.ts` in the clinic repository):

```json
{ "clients": [...], "debts": [...], "payments": [...], "medicines": [...], "reminders": [...] }
```

`medicines` and `reminders` are optional. Records keep the fields the clinic stores in `clinics/agrovet/{collection}`: the document id as `id`, amounts as integer centimes, dates as `YYYY-MM-DD`, and timestamps as ISO strings. Firestore `{seconds, nanoseconds}` timestamps are also accepted. Keep the cached client fields (`totalDebt`, `totalPaid`, `balance`, `lastDebtDate`) and the debt fields `deletedAt` and `archived`. Reconciliation depends on them.

You can produce the export in any of these ways. Each one only reads production:

- **Managed export, then emulator.** Run `gcloud firestore export` to a bucket. This is a read-only operation on the database. Load the result into the local Firestore emulator (`firebase emulators:start --import`), then dump the five collections to JSON from the emulator.
- **Read-only account.** A clinic administrator runs a small script outside this repository with an account that has only the *Cloud Datastore Viewer* role. The script lists the five collections and writes the JSON above. Do not use the clinic's `agrovet` callable function, because its actions write data.

Afterwards, check the clinic audit log to confirm that nothing changed. The export holds client names, phone numbers and clinical notes. Store it encrypted, do not email it, and delete it once the import is verified.

## 2. Dry run and review

```ts
import { planAgrovetImport, agrovetCommitPayload } from "@/lib/migration/agrovet";
const plan = await planAgrovetImport(jsonTextOrObject, { workspaceId });
// plan.records: parties, obligations, payments, allocations, reminders (nothing is saved yet)
// plan.report:  review report;  plan.idMap: Agrovet id → Nsalek id;  plan.fileHash
```

The planner is pure: the same input and `now` always give the same plan. Read the report before you commit:

- `ready`: false while any `blocking` item exists, for example a payment or debt allocated beyond its amount. `commitImport` would refuse such a batch anyway.
- `counts.<entity>`: `source`, `imported`, `skipped` (by reason) and `orphaned`. Every entity satisfies `source = imported + Σ skipped + orphaned`. Medicines are always `skipped.not_imported`.
- `totals`: the clinic's cached figures next to figures recomputed from the planned records with the app's own ledger code (`buildIndex`, `figuresOf`, `partyBalance`):
  - `debt`: Σ `client.totalDebt` against Σ imported principal, plus opening balances.
  - `paid`: Σ `client.totalPaid` against Σ imported allocations. Orphaned, skipped and opening-balance-covered amounts are listed separately.
  - `balance`: Σ `client.balance` against Σ outstanding minus unallocated advances.
- `mismatches`: each client whose cached balance differs from the recomputed one.
- `review`: one item per decision, with a severity, a code, the Agrovet id, the new id and an amount. It never contains names, notes or medical text.
- `withheld` / `included`: counts of fields that were not copied, or were copied because of an opt-in.
- `followUpDates`: Agrovet `reminderDate` is a follow-up date. It becomes `remindOn`, and `dueDate` stays empty.

### Mapping rules

| Agrovet | Nsalek |
|---|---|
| client | `Party` (person, customer). Name, phone (normalized to +213…), address and `legacy` ref are kept. An archived client becomes an archived party. |
| debt | Receivable `Obligation`, kind `service`, principal = `totalAmount`, description `Agrovet <date>`, tag `agrovet` |
| debt with `deletedAt` and no payment | Skipped, because it was voided (`skipped.voided`) |
| debt with `deletedAt` and payments | Imported, flagged `debt_deleted_with_payments` |
| `archived` debt (hidden in the old UI) | Imported as live, tag `agrovet:archived`. A hidden row is not a deleted debt. |
| payment | Receivable `Payment`. Method `cash` stays `cash`; anything else becomes `other`. Allocations come from `payment.allocations` and are dated on the payment date. |
| allocation to a missing, skipped or other-client debt | Not imported (`allocation_orphan`). The remainder is kept as a flagged advance (`allowAdvance: true`). |
| payment without a known client | Not imported (orphaned) |
| reminder (`composer_opened`) | `ReminderLog`, channel `sms`, status `opened_for_sharing`. Nothing proves the SMS was sent. |
| medicine catalog | Not imported, only counted |
| client with `balance > 0` and no importable debt | One `opening_balance` obligation for that balance, dated `lastDebtDate` or today. The client's payments are already netted into the balance, so they are skipped (`covered_by_opening_balance`). A client never gets both an opening balance and historical debts. |

Ids are deterministic: `ag_c_<id>`, `ag_d_<id>`, `ag_ob_<clientId>`, `ag_p_<id>`, `ag_a_<paymentId>_<n>` and `ag_r_<id>`. Importing the same data twice therefore collides instead of doubling the debts.

## 3. Commit

1. Take a Nsalek backup first (`createBackup`, the app's backup export).
2. Commit in one transaction:

```ts
await execute(store, { id: commandId, type: "commitImport", payload: agrovetCommitPayload(plan, file.name) });
```

`commitImport` refuses a `fileHash` that is already committed (`already_imported`). It re-verifies every affected party: no negative outstanding, no over-allocated payment, and allocations only between a posted debt and a payment with the same direction and currency. It stores the review report on the `ImportBatch`. `fileHash` is the SHA-256 of the canonical JSON content, so formatting and key order do not change it.

## 4. Reconciliation checks after commit

- The workspace receivable total equals `report.totals.balance.net`. In a clean export it also equals Σ `client.balance`.
- Spot-check several clients: the party balance (receivable minus advance) equals the clinic's cached `balance`. Look at every client listed in `report.mismatches`.
- Resolve every `payment_unallocated_advance` item. Apply the advance to the right debt, or reverse the payment.
- `validateLedger` (also run on every backup restore) reports no issues.

## 5. Rollback

- **Reverse the batch:** `execute(store, { id, type: "reverseImport", payload: { batchId, reason } })`. This voids the imported obligations, reverses the imported payments and their allocations, and archives the imported parties that have no other debts. Everything is audited and kept as history. It is refused (`import_in_use`) if a payment recorded after the import was allocated to an imported debt. Reverse that payment first.
- **Restore the backup** taken before the import. A replace-mode restore also saves an automatic pre-restore snapshot of the current data.
- **Re-importing after a reversal:** the reversed rows keep their ids, so pass a new `idPrefix` (for example `"ag2"`).

## 6. Medical-data policy

By default **no** species, animal quantity, unit price, medicine name, clinical note, payment note or reminder text is copied. The report shows only how many fields were withheld. Each opt-in is a separate choice:

| Option | Effect |
|---|---|
| `includeVeterinaryDetails` | Species, quantity, unit price and medicine names go **only** into `obligation.extension.veterinary` |
| `includeClientNotes` | Client notes go into party notes. They may hold clinical information. |
| `includePaymentNotes` | Payment notes go into payment notes (truncated to 1,000 characters, flagged) |
| `includeReminderMessages` | Reminder text is stored. Otherwise a neutral placeholder is stored. |

Debt notes are never imported: Nsalek has no non-clinical place for them. The medicine catalog is never imported.

## Known limitations

- Ids are global to the device. Importing the same export into a second workspace on the same device needs a different `idPrefix`.
- Amounts are assumed to be DZD centimes (`currency` option). The importer never converts currencies.
- Reminder status other than `composer_opened` is imported as `prepared`, the weakest claim.

# Feature mapping: clinic app → Nsalek

Legend: **Keep** (same behavior), **Generalize** (same intent, broader model), **Isolate** (optional module or extension), **Repair** (fixed defect), **Drop** (not carried over).

| Clinic feature (reference) | Decision | Nsalek implementation | Reason |
|---|---|---|---|
| Client (`lib/model.ts:3`) | Generalize | `Party` (person or organization) needs only a display name; phones, email, address, tax info, tags and roles are optional. A party can be both customer and supplier | Any contact, not only livestock owners |
| Mandatory Algerian mobile phone (`functions/core.mjs:18`) | Repair | Optional `phones[]`, normalized to E.164 (+213 default, other countries accepted) | Name-only contacts, landlines, foreign numbers |
| Debt priced per animal (`functions/core.mjs:50`) | Generalize | `Obligation` with a plain `principal`, `direction` (receivable/payable), `currency`, optional due date and description | General debts |
| Species and medicine fields | Isolate | Optional `extension.veterinary` on an obligation, filled only by the legacy importer with explicit opt-in | No medical data by default |
| Medicine catalog (`saveMedicine`) | Isolate (not imported by default) | Counted in the migration report; optional catalog in the veterinary extension | Domain-specific |
| Clinic `agrovet` singleton | Generalize | `Workspace` records; every record carries `workspaceId`, and commands check that references stay in one workspace | Multiple ledgers and businesses |
| Clinic identity in SMS/statements (`lib/clinic.ts`) | Generalize | Workspace business identity (name, phone, address), configurable brand in `lib/brand.ts` | Placeholder brand |
| Oldest-first allocation (`functions/core.mjs:63`) | Keep + generalize | `planAllocation()` orders by due date, then date, then creation time, then id. The preview can be adjusted by hand. Direction and currency are checked | Same semantics, more control |
| Overpayment rejection | Keep + extend | Rejected by default; an explicit "record advance" option keeps the remainder as an unallocated advance | Master prompt §4 |
| Idempotent `operations/{requestId}` | Keep | `commands` store keyed by command id inside the same IndexedDB transaction | Fixture E |
| Client-level transaction serialization | Keep | Each command runs in one IndexedDB `readwrite` transaction, which the browser serializes across tabs | Fixture L |
| Debt edit in place (`saveDebt`) | Repair | Posted amounts are immutable. Corrections use adjustments or void + replace, both audited with a reason | Audit integrity |
| No payment reversal | Repair | `reversePayment` keeps the payment, marks it and its allocations reversed with actor, time and reason | Fixture F |
| Void unpaid debt / archive paid debt | Keep + clarify | `voidObligation` is allowed only without active allocations. Hiding a party is `archive`, and debts stay financially active | Hidden row ≠ deleted debt |
| Archive client blocked by balance | Generalize | Archiving a party with an outstanding balance needs a confirmation; balances stay in totals | Personal users may hide a contact while keeping the debt |
| Cached client/clinic counters | Repair | No cached totals. Every balance is derived from obligations, adjustments and allocations by one tested module (`lib/core/ledger.ts`) | Reconciles by construction |
| `reminderDate` | Generalize | Separate `dueDate` (payment due) and `remindOn` (follow-up) | Distinct concepts |
| Reminder queue buckets (`reminderQueue`) | Generalize | Collections view: today's actions, overdue aging buckets, due this week, promises, guided reminder queue | Master prompt §6 |
| SMS composer + `composer_opened` (`lib/sms.ts`) | Keep + extend | WhatsApp (`wa.me`), SMS and email composers. Status flow: prepared → opened for sharing → manually marked sent. Never "delivered" | Honest statuses |
| Balance revalidation before reminder | Keep | Message amount is recomputed from the ledger when the reminder is opened | — |
| Printable statement (`Views.tsx:808`) | Keep + extend | Statement with business identity, period, opening balance, dated movements, closing balance, per-currency/direction sections, repeated table headers and a bundled Arabic/Latin font | Master prompt §8 |
| CSV export with formula guard (`Views.tsx:1190`) | Keep + extend | Same guard applied to all user text fields; exports for parties, obligations, payments and statements | — |
| Reports (`report`, `periodStats`) | Generalize | Receivables/payables, aging, cash received/paid, movements, per-party balances, upcoming installments, waived amounts. Species/medicine stats dropped | Clinic-only |
| FR/AR dictionaries, RTL (`lib/i18n.ts`) | Keep + extend | New dictionary with FR, AR and EN; neutral Arabic labels with optional Algerian wording (ليك / عليك) | Master prompt §9 |
| Light/dark/system theme | Keep | Same tokens approach (`data-theme`) | — |
| Demo mode | Keep | Deterministic synthetic demo workspace, clearly labeled, removable | — |
| Firebase auth, membership, callable backend | Drop from P0/P1 | Local-first IndexedDB; sync and teams documented as a P2 boundary (`lib/sync/README.md`) | No account required; avoids touching production |
| Server pagination (25) and 1,000-record report cap | Drop | Local in-memory derived views. Measured with 1,000 parties / 50,000 movements (`docs/performance.md`) | No server round trips |
| WebMCP `start_agrovet_debt` | Keep (renamed) | `start_nsalek_debt` opens the quick-add form and never saves | Agent-safe entry point |
| vinext / Cloudflare / drizzle plumbing | Drop | Plain Next.js static export | Unused |
| — (new) | Add | Payables, multi-currency, adjustments/waivers, netting, installments, recurrence, promises, invoices, attachments, CSV import, backup/restore with encryption, app lock, hide amounts, draft notes, clinic importer | Master prompt P0/P1 |

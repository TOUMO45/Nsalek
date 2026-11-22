# Performance of the financial core (1,000 people / 50,000 movements)

## After fixes (same machine, same deterministic dataset, 2026-11-22 ~21:00 local)

Findings 1–5 below were fixed, then `node scripts/bench.ts --full-restore` was run again. Raw output: `bench-results/after-fix-run.txt` and `bench-results/node-2026-11-22.json`. Pre-fix JSON: `bench-results/node-2026-11-22-before-fixes.json`. Validation was unchanged: `validateLedger` 0 issues, identical payload sha256 `4318309d2c7d…`.

| Operation | Before (median) | After (median) | Change |
|---|---:|---:|---|
| `prepareRestore`, full dataset (142,482 records, 1 run) | 595,343 ms | **7,866 ms** | `MemoryStore` point lookups made O(1) (`lib/core/store.ts`) |
| `prepareRestore`, 50 / 100 / 200 parties | 1,302 / 4,621 / 14,630 ms | 300 / 615 / 918 ms | now grows linearly |
| MemoryStore `recordPayment` per command | 72.43 ms | 5.25 ms | same fix |
| `searchParties` name `"ben"` | 94.73 ms | 8.55 ms | normalized text cached per index (`lib/core/ledger.ts`) |
| `searchParties` phone `"023680"` | 130.29 ms | 11.48 ms | same |
| `searchParties` local prefix `"05500236"` | 78.76 ms, **0 matches (bug)** | 11.66 ms, expected party found | phones are also searched in national form (`0` + 9 digits) |
| `createBackup`, encrypted | 6,238.79 ms | 2,833.52 ms | `bytesToBase64` per 3-byte-aligned chunk (`lib/core/crypto.ts`) |
| `bytesToBase64(ciphertext)` | 3,773.44 ms | 902.33 ms | same |
| `dailyActions` | 25.42 ms | 28.64 ms | `Map` instead of a linear scan; within run-to-run noise |

Not changed: `canonical()` cost (finding 6), so opening an unencrypted backup still takes about 2.6 s. Real browser IndexedDB timings remain **pending** (see the end of this file).

---

The sections below are the original pre-fix report from the benchmark track, kept for reference.

The numbers below come from one run of `node scripts/bench.ts --full-restore` on 2026-11-22 at 19:42:26 UTC. The raw output is `bench-results/node-2026-11-22.json`. Nothing here is estimated or extrapolated. Sums or ratios that are derived from measured values say so.

## Environment

| Item | Value |
|---|---|
| Node | v24.15.0 (V8 13.6.233.17-node.48), `.ts` run directly via type stripping |
| OS | Windows 11 Pro (Windows_NT 10.0.26300), win32/x64 |
| CPU | AMD Ryzen 7 7730U with Radeon Graphics, 16 logical cores (`os.cpus().length`), laptop |
| RAM | 38.827 GiB total, 23.23 GiB free at start |
| Time zone | Africa/Algiers |
| GC control | none (`--expose-gc` not used) |
| Background load | not controlled: other agent processes (Codex, opencode, several Node processes) were running on the machine |

The core runs single-threaded, so the core count does not affect these numbers.

## Dataset

The generator is deterministic: a mulberry32 PRNG with seed `20261122`, a fixed clock of `2026-11-22T10:00:00Z` and "today" set to `2026-11-22`. Records are built directly in memory with the same shapes the command handlers write. Allocations are planned with the core's own `planAllocation` (oldest due first). The run aborts if any of these checks fails:

- `validateLedger(data)` returned **0 issues**.
- An independent check of the simulated outstanding amount against `figuresOf()` found **0 mismatches** over 26,072 posted obligations.
- The backup payload SHA-256 is `4318309d2c7dd99c1dab45df2cf0d14e7146cf266cef26337965e1bf38c84fdc`. It was identical in both runs that day.

| Store | Count | Notes |
|---|---:|---|
| workspaces | 1 | DZD, business mode (payments get receipt numbers) |
| parties | 1,000 | 731 persons, 269 organizations; 708 with phones (`+2135500xxxxx`); 390 with tags; 19 archived; 6 snoozed |
| obligations | 26,752 | 26,072 posted, 283 draft, 397 voided; 21,075 receivable, 5,677 payable; 24,116 DZD, 2,636 EUR (9.9%); 17,319 with a due date (15,049 in the past, 2,270 today or later); 268 disputed; 2,561 still open, 930 open and overdue |
| payments | 21,030 | 20,895 posted, 135 reversed, 129 with an explicit advance, 4,182 EUR |
| allocations | 36,548 | 36,309 active, 239 reversed (belonging to reversed payments) |
| adjustments | 2,218 | 575 increase, 546 decrease, 664 waiver, 433 write-off |
| installmentPlans | 150 | active, monthly |
| promises | 300 | |
| reminders | 2,500 | |
| audit | 51,983 | one per create/void/reverse/adjust/plan/promise command, with `before`/`after` like the handlers |
| **total records** | **142,482** | plus 54,483 `commands` records, which are loaded into the stores for the command test but are not part of backups |

**Movements**: obligations + payments + adjustments = 26,752 + 21,030 + 2,218 = **50,000** exactly. Each party has between 3 and 630 movements (median 31). The busiest party (`pty_c025121`, 630 movements) is the one used for the statement.

After generation the process used 179.0 MiB of heap and 330.6 MiB RSS. Generation took 1,339 ms.

## Results

Timing uses `performance.now()`. Fast operations get 1 untimed warm-up run plus 7 timed runs; backup operations get 1 warm-up plus 5. Each table shows the median, min and max.

### Derived views (in memory, after `buildIndex`)

| Operation | Median ms | Min | Max | Output |
|---|---:|---:|---:|---|
| buildIndex | 57.77 | 42.75 | 70.69 | 26,752 obligations, 21,030 payments indexed |
| workspaceTotals | 18.04 | 16.13 | 26.83 | DZD receivable 3,595,507,300 / payable 946,670,000 minor |
| partyBalance × 1,000 parties | 15.45 | 13.13 | 18.70 | 1,000 balances |
| partyEffects (busiest party, 630 movements) | 0.90 | 0.53 | 1.19 | 617 effects |
| buildStatement DZD 2026-01-01..today (busiest party) | 0.97 | 0.70 | 1.70 | 436 rows |
| agingReport receivable | 5.95 | 5.23 | 7.68 | DZD 1,747 open, EUR 299 open |
| agingReport payable | 1.26 | 0.97 | 2.05 | DZD 445 open, EUR 70 open |
| overdueList receivable | 4.28 | 3.42 | 6.19 | 737 overdue debts |
| reminderQueue | 8.45 | 7.25 | 11.38 | 391 parties |
| dailyActions | 25.42 | 22.25 | 41.02 | 799 actions |
| periodReport 2025-11-23..2026-11-22 | 14.41 | 10.59 | 24.08 | DZD 16,445 obligations / 11,905 payments |
| perPartyBalances | 11.53 | 9.94 | 14.82 | 1,178 rows |
| validateLedger | 113.35 | 104.53 | 153.68 | 0 issues |

### Search (`searchParties`, 1,000 parties)

| Query | Median ms | Min | Max | Matches |
|---|---:|---:|---:|---|
| name `"ben"` | 94.73 | 82.55 | 111.47 | 118 (name) |
| phone fragment `"023680"` | 130.29 | 110.20 | 145.71 | 1 (phone) |
| domestic phone prefix `"05500236"` | 78.76 | 67.51 | 93.50 | **0**: the expected party (`+213550023680`) was **not found** (see finding 4) |
| amount `"18000"` | 75.11 | 66.41 | 84.77 | 31 (amount) |
| empty query + `{direction: receivable, due: overdue}` | 9.74 | 7.33 | 14.04 | 397 |
| breakdown: `normalizeText` × 26,072 obligation description+reference strings | 64.99 | 45.53 | 79.01 | the text fallback a non-empty query pays |

### Backups

PBKDF2 uses the production default from `lib/core/crypto.ts`: `PBKDF2_ITERATIONS = 310000`, PBKDF2-SHA-256, AES-GCM-256.

| Operation | Median ms | Min | Max |
|---|---:|---:|---:|
| createBackup, unencrypted | 2,094.92 | 1,750.14 | 2,299.87 |
| serializeBackup, unencrypted | 562.91 | 509.83 | 690.95 |
| createBackup, encrypted (310,000 iterations) | 6,238.79 | 5,541.63 | 6,720.16 |
| parseBackup + openBackup, encrypted | 1,457.01 | 1,308.84 | 1,663.49 |
| parseBackup + openBackup, unencrypted | 2,693.48 | 2,470.28 | 2,939.74 |

Serialized size: **67,400,184 bytes (67.4 MB)** unencrypted and **89,866,762 bytes (89.867 MB)** encrypted (1 MB = 10^6 bytes).

Where the backup time goes (each step timed on its own with the same primitives):

| Step | Median ms | Min | Max |
|---|---:|---:|---:|
| `canonical(sortLedger(data))` (67,250,297 chars) | 1,401.85 | 1,291.69 | 1,574.60 |
| `sha256Hex(payload JSON)` | 256.59 | 238.19 | 283.99 |
| `JSON.parse(payload JSON)` | 396.64 | 322.20 | 436.48 |
| PBKDF2-SHA-256 key derivation, 310,000 iterations | 68.00 | 65.60 | 74.79 |
| AES-GCM-256 encrypt (67,399,322 bytes) | 117.97 | 82.20 | 166.71 |
| **`bytesToBase64(ciphertext)`** | **3,773.44** | 3,440.85 | 4,234.60 |
| `base64ToBytes(ciphertext)` | 316.15 | 309.81 | 428.52 |
| AES-GCM-256 decrypt | 225.55 | 122.34 | 245.06 |

### Restore validation (`prepareRestore`, one run per size)

`prepareRestore` runs `openBackup`, loads every record into a temporary `MemoryStore`, reads everything back, and runs `validateLedger` and `manifestMatches`. `restoreBackup` calls it before every restore.

| Parties | Records | ms | Result |
|---:|---:|---:|---|
| 50 | 8,746 | 1,302.2 | 0 issues, manifest ok |
| 100 | 16,244 | 4,620.8 | 0 issues, manifest ok |
| 200 | 29,138 | 14,629.8 | 0 issues, manifest ok |
| **1,000 (full)** | **142,482** | **595,343.1** (about 9.9 minutes) | 0 issues, manifest ok |

### Command throughput (`execute()`, N = 500 sequential commands, one read-write transaction each)

Each store was preloaded with the full dataset plus its 54,483 command records (196,965 records in total). Each recordPayment pays 100 DA, auto-allocated. Each createObligation is 2,500 DA, due in 30 days. `validateLedger` reported 0 issues after every batch.

| Store | Command | Preload ms | loadLedger ms | Total ms | Mean ms/cmd | Median | p95 | Max |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| MemoryStore | recordPayment | 1,664 | 1,133 | 36,215 | 72.43 | 67.68 | 106.90 | 193.05 |
| MemoryStore | createObligation | | | 19,331 | 38.66 | 36.51 | 54.66 | 118.34 |
| **fake-indexeddb in Node — NOT representative of browser IndexedDB** | recordPayment | 47,665 | 1,531 | 974 | 1.95 | 1.16 | 5.15 | 75.71 |
| **fake-indexeddb in Node — NOT representative of browser IndexedDB** | createObligation | | | 115 | 0.23 | 0.23 | 0.31 | 0.91 |

The fake-indexeddb figures only show that the adapter code path works at this size. They say nothing about how fast Chrome, Safari or Firefox IndexedDB is.

### Run-to-run variance

An earlier run the same day (19:37 UTC, without `--full-restore`) printed these numbers to the console. Its JSON file was overwritten by the run above.

| Operation | Earlier run | Run above |
|---|---:|---:|
| createBackup, unencrypted | 1,673.43 ms | 2,094.92 ms |
| createBackup, encrypted | 4,928.20 ms | 6,238.79 ms |
| searchParties, phone fragment | 90.51 ms | 130.29 ms |
| MemoryStore recordPayment, mean per command | 65.62 ms | 72.43 ms |
| fake-indexeddb preload | 36,160 ms | 47,665 ms |
| prepareRestore, 50 / 100 / 200 parties | 917 / 3,126 / 12,146 ms | 1,302 / 4,621 / 14,630 ms |

So treat individual numbers as accurate to roughly ±25–40% on this machine.

## Interpretation

The rule used here: an operation that runs on a tap or a keystroke should take under 100 ms on this desktop. A mid-range phone will be slower, by an amount not measured here.

**Fine for interactive use:**
- Every balance, statement, aging, due list, reminder queue, daily action and report function takes 0.9–25 ms once an index exists.
- `buildIndex` takes 58 ms. If the UI rebuilds the index and recomputes the home views (totals, daily actions, reminder queue) after every command, those medians add up to about 110 ms (a sum of medians, not one measurement). That is the next thing to watch on phones.
- A statement for a party with 630 movements takes under 1 ms.

**Slow (over 100 ms, or multi-second):**
1. **`prepareRestore` (`lib/core/restore.ts`) on top of `MemoryStore` (`lib/core/store.ts`): 595 s for the full dataset.** Cost grows quadratically: 1.86× the records cost 3.5× the time, and 1.79× cost 3.2×. On every `get`, `add`, `where` and `all`, `MemoryStore.exec`'s `current(store)` builds a new `Map` from the committed table plus every pending write in the transaction. `prepareRestore` calls `tx.add` for every record inside one transaction, so the i-th add copies i−1 pending entries.
   - **Consequence:** restoring a backup of this size through `restoreBackup` would hang for about 10 minutes on this desktop, longer on a phone. From reading the code, not from a measurement: `app/ui/More.tsx` calls `prepareRestore` for the preview and then `restoreBackup`, which runs `prepareRestore` again, so the app pays this cost twice.
   - **Suggested fix:** make `MemoryStore` look up `pending` first and then the table, without materializing a merged map, in `get`, `add` and `has`. Iterate table plus pending once in `all` and `where`. Alternatively, have `prepareRestore` validate the decoded `LedgerData` directly, since `validateLedger` already reports `duplicate_id`, or use `put`.
2. **`MemoryStore` commands: 72 ms per recordPayment and 39 ms per createObligation**, from the same `current()` copying. Each command copies several 20k–55k-entry tables (commands, audit, allocations, obligations, payments). The browser app stores its data in IndexedDB. It uses `MemoryStore` only for restore validation (through `prepareRestore`) and for the small sample-statement page, so fixing item 1 fixes this as well.
3. **`searchParties` (`lib/core/ledger.ts`): 75–130 ms for any non-empty query.** By comparison, the empty query with a filter takes 10 ms. Every party that does not match by name, phone or amount reaches the final text branch, which runs `normalizeText(o.description + " " + o.reference)` on each of its posted obligations. That alone costs 65 ms for 26,072 strings.
   - **Suggested fix:** compute a normalized search text per party once per `LedgerIndex` (lazily, for example in a `WeakMap<LedgerIndex, …>`), so each keystroke only runs `includes`. Debounce input in the UI.
4. **Functional bug in `searchParties` phone matching.** It tests `phoneKey(p).includes(digits.slice(-9))`. When a domestic fragment with fewer than 10 digits is typed, such as `0550 0236`, the trunk `0` is kept, so it never matches a stored E.164 number. Measured result: `"05500236"` returned 0 matches, while the party `+213550023680` exists and `"023680"` found it.
   - **Suggested fix:** strip a leading `0`, `213` or `00213` from the query digits before matching.
5. **Encrypted `createBackup` takes 6.2 s, and 3.8 s of that is `bytesToBase64` (`lib/core/crypto.ts`).** For comparison, PBKDF2 at 310,000 iterations takes only 68 ms and AES-GCM 118 ms. The function builds one 67 MB binary string by `+=` of `String.fromCharCode` chunks and then calls a single `btoa`.
   - **Suggested fix:** call `btoa` per chunk, with the chunk length a multiple of 3, and `join` the parts. Or use `Uint8Array.prototype.toBase64()` where available. Neither was measured.
6. **`canonical()` (`lib/core/backup.ts`) takes 1.4 s,** and an unencrypted `openBackup` runs it again on the parsed payload. That is why opening an unencrypted backup (2.69 s) is slower than opening an encrypted one (1.46 s), which hashes the decrypted string directly.
   - **Possible fix:** store the canonical JSON string as the payload in both modes, at the cost of a format change.
7. `validateLedger` takes 113 ms but runs only on restore and merge, so it is acceptable.
8. Minor: in `dailyActions`, `pushOnce` uses `out.find` (a linear scan) for every repeated key. It costs 25 ms at this size, but its cost grows with actions × repeats. A `Map` keyed by `kind:party:currency` would make it constant-time.

## How to reproduce

```sh
npm run bench                       # about 3 min here: dataset, core timings, backups, restore on 50/100/200 parties, commands
npm run bench -- --full-restore     # also prepareRestore on the full dataset (about 10 more minutes here)
```

The script writes `bench-results/node-<YYYY-MM-DD>.json`, overwriting a file from the same day, and prints the markdown tables above. It exits with code 1 if `validateLedger` finds any issue or the outstanding cross-check fails. `.gitignore` excludes only `bench-results/*.local.json`, so the dated `node-<date>.json` files are meant to be committed.

## Pending (not measured by this script)

- **Real browser IndexedDB load and save times on a phone and on a desktop:** opening the database, `loadLedger` of about 197k records, one command's read-write transaction, and a full restore write. The fake-indexeddb numbers above are not a substitute.
- How fast the core functions run in a browser main thread, especially on a mid-range Android phone, and the memory peak on such a device during a 67–90 MB backup.
- How long `restoreBackup` takes end to end in the app (snapshot, write, reload) at this size.

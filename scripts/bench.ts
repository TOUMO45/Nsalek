// Performance benchmark for the Nsalek financial core.
//
//   node scripts/bench.ts            (same as `npm run bench`)
//   node scripts/bench.ts --full-restore   also times prepareRestore() on the full dataset
//
// 1. Builds a deterministic synthetic ledger in memory (seeded PRNG, fixed clock): one DZD
//    workspace, 1,000 parties and exactly 50,000 movements (obligations + payments + adjustments),
//    plus the allocations, audit events and command records the real handlers would have written.
//    The data must pass validateLedger() with zero issues, and every simulated outstanding amount
//    must equal the one derived by the core; otherwise the script exits with code 1.
// 2. Times the derived views, search, reports, validation and backups (median of several runs).
// 3. Times sequential commands through execute() against MemoryStore and fake-indexeddb.
// 4. Writes bench-results/node-<YYYY-MM-DD>.json and prints a markdown table.
//
// Only numbers measured during this run are written. Nothing is estimated or extrapolated.
import os from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import { addDays, daysBetween } from "../lib/core/dates.ts";
import {
  buildIndex,
  buildStatement,
  figuresOf,
  partyBalance,
  partyEffects,
  planAllocation,
  searchParties,
  workspaceTotals,
  type LedgerIndex,
  type PartyFilters,
  type PartyMatch,
} from "../lib/core/ledger.ts";
import { agingReport, dailyActions, overdueList, reminderQueue } from "../lib/core/collections.ts";
import { periodReport, perPartyBalances } from "../lib/core/reports.ts";
import { canonical, createBackup, openBackup, parseBackup, serializeBackup, sortLedger, validateLedger } from "../lib/core/backup.ts";
import { loadLedger, prepareRestore } from "../lib/core/restore.ts";
import { defaultSettings, execute } from "../lib/core/commands.ts";
import { base64ToBytes, bytesToBase64, PBKDF2_ITERATIONS, sha256Hex } from "../lib/core/crypto.ts";
import { buildSchedule } from "../lib/core/installments.ts";
import { normalizeText, phoneKey } from "../lib/core/text.ts";
import { MemoryStore, type Store } from "../lib/core/store.ts";
import { openStore } from "../lib/storage/idb.ts";
import {
  DATA_STORES,
  emptyLedger,
  type Adjustment,
  type AdjustmentType,
  type AuditEvent,
  type CommandRecord,
  type CurrencyCode,
  type Direction,
  type ISODate,
  type InstallmentPlan,
  type LedgerData,
  type Obligation,
  type ObligationKind,
  type Party,
  type Payment,
  type PaymentMethod,
  type PromiseToPay,
  type ReminderChannel,
  type ReminderLog,
  type ReminderStatus,
  type Workspace,
} from "../lib/core/types.ts";

// ---------------------------------------------------------------- parameters

const SEED = 20261122;
const PARTY_COUNT = 1000;
const MOVEMENT_TARGET = 50_000;
const NOW = new Date("2026-11-22T10:00:00Z"); // 11:00 in Africa/Algiers
const TODAY: ISODate = "2026-11-22";
const HISTORY_START: ISODate = "2024-01-01";
const WS_ID = "ws_bench";
const FAST_RUNS = 7;
const SLOW_RUNS = 5;
const COMMAND_N = 500;
const PASSPHRASE = "benchmark passphrase 2026";
const FULL_RESTORE = process.argv.includes("--full-restore");

// ---------------------------------------------------------------- seeded PRNG (mulberry32)

function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const chance = (p: number) => next() < p;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
  const weighted = <T>(list: readonly (readonly [T, number])[]): T => {
    const total = list.reduce((n, [, w]) => n + w, 0);
    let r = next() * total;
    for (const [v, w] of list) {
      r -= w;
      if (r < 0) return v;
    }
    return list[list.length - 1][0];
  };
  const gauss = () => {
    const u = Math.max(next(), 1e-12);
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, int, chance, pick, weighted, gauss };
}
type Rng = ReturnType<typeof makeRng>;

const pad = (n: number, w: number) => String(n).padStart(w, "0");

// ---------------------------------------------------------------- vocabulary

const FIRST = ["Mohamed", "Ahmed", "Karim", "Yacine", "Sofiane", "Amine", "Rachid", "Nadia", "Samira", "Fatima", "Amina", "Yasmine", "Lyes", "Walid", "Hocine", "Mourad", "Djamel", "Farid", "Nassim", "Imane", "Sara", "Meriem", "Khadidja", "Abdelkader", "Omar", "Bilal", "Hamza", "Riad", "Zineb", "Lamia"];
const LAST = ["Benali", "Bensaid", "Boudiaf", "Belkacem", "Bouzid", "Haddad", "Mansouri", "Saadi", "Cherif", "Kaci", "Hamidi", "Brahimi", "Benyahia", "Djebbar", "Ait Ahmed", "Belaid", "Meziane", "Rahmani", "Zerrouki", "Taleb", "Bouchama", "Khelifi", "Ouali", "Amrani", "Ferhat", "Larbi", "Mebarki", "Benmoussa", "Slimani", "Ziani"];
const AR_FIRST = ["محمد", "أحمد", "كريم", "ياسين", "فاطمة", "أمينة", "سمير", "نادية", "عبد القادر", "خديجة", "إيمان", "مراد"];
const AR_LAST = ["بن علي", "بوزيد", "حداد", "منصوري", "سعدي", "شريف", "براهيمي", "بلقاسم", "زروقي", "طالب", "مزيان", "عمراني"];
const ORG_PREFIX = ["SARL", "EURL", "Ets", "Pharmacie", "Supérette", "Quincaillerie", "Boulangerie", "Transport", "Clinique vétérinaire", "Agrovet"];
const CITIES = ["Alger", "Oran", "Blida", "Sétif", "Béjaïa", "Tizi Ouzou", "Constantine", "Batna", "Médéa", "Bouira"];
const TAGS = ["grossiste", "détail", "famille", "voisin", "fournisseur", "vip", "marché", "éleveur"];
const DESCRIPTIONS = ["Achat marchandises", "Vente à crédit", "Prêt personnel", "Réparation", "Livraison", "Ciment 20 sacs", "Médicaments", "Aliment bétail", "Pièces détachées", "Facture électricité partagée", "سلف", "دين", "سلعة بالكريدي", "Engrais", "Location matériel"];
const ADJ_REASONS = ["Remise accordée", "Erreur de prix", "Geste commercial", "Créance irrécouvrable", "Frais de retard", "Retour marchandise"];
const KIND_WEIGHTS: readonly (readonly [ObligationKind, number])[] = [["debt", 40], ["credit_sale", 30], ["service", 15], ["loan", 10], ["opening_balance", 5]];
const METHOD_WEIGHTS: readonly (readonly [PaymentMethod, number])[] = [["cash", 60], ["ccp_baridimob", 20], ["bank_transfer", 15], ["card", 3], ["other", 2]];
const ADJ_WEIGHTS: readonly (readonly [Exclude<AdjustmentType, "netting">, number])[] = [["increase", 25], ["decrease", 25], ["waiver", 30], ["write_off", 20]];

// ---------------------------------------------------------------- generator

type OpenEntry = { obligation: Obligation; outstanding: number };

type Generated = {
  data: LedgerData;
  commands: CommandRecord[];
  /** Simulated outstanding per posted obligation, independent of the core's derivation. */
  outstanding: Map<string, number>;
  movementsByParty: Map<string, number>;
  phoneOfParty: Map<string, string>;
};

function generate(): Generated {
  const rng: Rng = makeRng(SEED);
  const data = emptyLedger();
  const commands: CommandRecord[] = [];
  const outstanding = new Map<string, number>();
  const movementsByParty = new Map<string, number>();
  const phoneOfParty = new Map<string, string>();
  let seq = 0;
  let clockSeq = 0;
  let receiptSeq = 0;
  const nextCmd = () => `c${pad(++seq, 6)}`;
  // Timestamps between 07:00 and 10:00 UTC of the given day, so nothing is later than NOW.
  const stamp = (date: ISODate) => new Date(Date.parse(`${date}T07:00:00Z`) + (clockSeq++ % 10_800) * 1000).toISOString();
  const minDate = (a: ISODate, b: ISODate) => (a < b ? a : b);
  const audit = (commandId: string, n: number, at: string, e: Omit<AuditEvent, "id" | "workspaceId" | "at" | "actor" | "commandId">) =>
    data.audit.push({ id: `aud_${commandId}_${n}`, workspaceId: WS_ID, at, actor: "owner", commandId, ...e });
  const command = (id: string, type: string, at: string, result: unknown) => commands.push({ id, type, at, result });

  // Workspace (business mode: payments get receipt numbers, like the real handler).
  const wsCmd = nextCmd();
  const ws: Workspace = {
    id: WS_ID,
    name: "Commerce Bench",
    mode: "business",
    defaultCurrency: "DZD",
    timezone: "Africa/Algiers",
    country: "DZ",
    business: { name: "Ets Bench", phone: "+213550000000", address: "Blida", email: "", taxId: "" },
    settings: defaultSettings(),
    createdAt: stamp(HISTORY_START),
    demo: false,
  };
  data.workspaces.push(ws);
  command(wsCmd, "createWorkspace", ws.createdAt, { workspaceId: WS_ID });
  audit(wsCmd, 1, ws.createdAt, { action: "workspace.create", entityType: "workspace", entityId: WS_ID, after: structuredClone(ws) });

  // Movement budget per party: log-normal weights, at least 3, summing to exactly MOVEMENT_TARGET.
  const weights = Array.from({ length: PARTY_COUNT }, () => Math.exp(rng.gauss()));
  const wSum = weights.reduce((n, w) => n + w, 0);
  const budgets = weights.map((w) => Math.max(3, Math.floor((w / wSum) * MOVEMENT_TARGET)));
  let diff = MOVEMENT_TARGET - budgets.reduce((n, b) => n + b, 0);
  while (diff !== 0) {
    const i = rng.int(0, PARTY_COUNT - 1);
    if (diff > 0) {
      budgets[i]++;
      diff--;
    } else if (budgets[i] > 3) {
      budgets[i]--;
      diff++;
    }
  }

  const usedNames = new Set<string>();
  const usedPhones = new Set<string>();
  const lastStart = "2026-10-31";

  for (let i = 0; i < PARTY_COUNT; i++) {
    const start = addDays(HISTORY_START, rng.int(0, daysBetween(HISTORY_START, lastStart)));
    const isOrg = rng.chance(0.25);
    let name: string;
    if (isOrg) name = `${rng.pick(ORG_PREFIX)} ${rng.pick(LAST)}`;
    else if (rng.chance(0.2)) name = `${rng.pick(AR_FIRST)} ${rng.pick(AR_LAST)}`;
    else name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    if (usedNames.has(name)) name = `${name} ${rng.pick(CITIES)}`;
    if (usedNames.has(name)) name = `${name} ${i + 1}`;
    usedNames.add(name);

    const profile = isOrg
      ? rng.weighted([["customer", 45], ["supplier", 35], ["both", 20]] as const)
      : rng.weighted([["customer", 75], ["supplier", 5], ["both", 20]] as const);
    const phones: string[] = [];
    if (rng.chance(0.7)) {
      let ph: string;
      do ph = `+2135500${pad(rng.int(0, 99_999), 5)}`;
      while (usedPhones.has(ph));
      usedPhones.add(ph);
      phones.push(ph);
      if (rng.chance(0.1)) phones.push(`+2137700${ph.slice(-5)}`);
    }
    const tags: string[] = [];
    if (rng.chance(0.4)) {
      tags.push(rng.pick(TAGS));
      if (rng.chance(0.3)) {
        const t = rng.pick(TAGS);
        if (!tags.includes(t)) tags.push(t);
      }
    }
    const city = rng.pick(CITIES);
    const partyCmd = nextCmd();
    const party: Party = {
      id: `pty_${partyCmd}`,
      workspaceId: WS_ID,
      kind: isOrg ? "organization" : "person",
      displayName: name,
      phones,
      email: "",
      address: rng.chance(0.6) ? city : "",
      taxId: "",
      tags,
      isCustomer: profile !== "supplier",
      isSupplier: profile !== "customer",
      notes: rng.chance(0.1) ? `Client depuis ${start.slice(0, 4)}, ${city}` : "",
      creditLimits: {},
      representatives: isOrg && rng.chance(0.3) ? [{ name: `${rng.pick(FIRST)} ${rng.pick(LAST)}`, phone: `+2135600${pad(i, 5)}`, role: "comptable" }] : [],
      snoozedUntil: rng.chance(0.01) ? addDays(TODAY, 5) : null,
      archivedAt: null,
      mergedIntoId: null,
      createdAt: stamp(start),
    };
    if (rng.chance(0.02)) party.archivedAt = stamp(TODAY);
    data.parties.push(party);
    if (phones[0]) phoneOfParty.set(party.id, phones[0]);
    command(partyCmd, "createParty", party.createdAt, { partyId: party.id });
    audit(partyCmd, 1, party.createdAt, { action: "party.create", entityType: "party", entityId: party.id, after: structuredClone(party) });

    // Chronological events for this party; each event is exactly one movement.
    const span = daysBetween(start, TODAY);
    const dates = Array.from({ length: budgets[i] }, () => addDays(start, rng.int(0, span))).sort();
    const open = new Map<string, OpenEntry>();
    let movements = 0;
    for (const date of dates) {
      movements++;
      const r = rng.next();
      const kind = open.size === 0 || r < 0.47 ? "obligation" : r < 0.95 ? "payment" : "adjustment";

      if (kind === "obligation") {
        const direction: Direction = profile === "customer" ? "receivable" : profile === "supplier" ? "payable" : rng.chance(0.7) ? "receivable" : "payable";
        const currency: CurrencyCode = rng.chance(0.1) ? "EUR" : "DZD";
        let principal: number;
        if (currency === "DZD") {
          const da = Math.min(2_000_000, Math.max(200, Math.exp(Math.log(15_000) + rng.gauss())));
          principal = Math.max(1, Math.round(da / 50)) * 50 * 100; // multiples of 50 DA
        } else {
          const eur = Math.min(20_000, Math.max(5, Math.exp(Math.log(300) + rng.gauss())));
          principal = Math.max(100, Math.round(eur * 100));
        }
        const dueDate = rng.chance(0.65) ? addDays(date, rng.pick([7, 15, 30, 30, 30, 45, 60, 90])) : null;
        const cmd = nextCmd();
        const createdAt = stamp(date);
        const roll = rng.next();
        const state: Obligation["state"] = roll < 0.01 ? "draft" : roll < 0.025 ? "voided" : "posted";
        const posted: Obligation = {
          id: `obl_${cmd}`,
          workspaceId: WS_ID,
          partyId: party.id,
          direction,
          kind: rng.weighted(KIND_WEIGHTS),
          currency,
          principal,
          date,
          dueDate,
          remindOn: rng.chance(0.05) ? addDays(date, rng.int(5, 40)) : null,
          description: `${rng.pick(DESCRIPTIONS)}${rng.chance(0.3) ? ` #${rng.int(1, 999)}` : ""}`,
          reference: rng.chance(0.3) ? `BL-${pad(rng.int(1, 99_999), 5)}` : "",
          tags: rng.chance(0.1) ? [rng.pick(TAGS)] : [],
          state: state === "draft" ? "draft" : "posted",
          voidedAt: null,
          voidReason: null,
          replacesId: null,
          replacedById: null,
          disputed: null,
          creditOverrideReason: null,
          attachmentIds: [],
          createdAt,
          createdBy: "owner",
        };
        if (state === "posted" && rng.chance(0.01)) posted.disputed = { since: createdAt, note: "Montant contesté" };
        command(cmd, "createObligation", createdAt, { obligationId: posted.id, installmentPlanId: null });
        audit(cmd, 1, createdAt, { action: state === "draft" ? "obligation.draft" : "obligation.post", entityType: "obligation", entityId: posted.id, after: structuredClone(posted), reason: null });
        if (state === "voided") {
          const voidCmd = nextCmd();
          const voidedAt = stamp(minDate(addDays(date, rng.int(0, 3)), TODAY));
          const voided: Obligation = { ...posted, state: "voided", voidedAt, voidReason: "Saisie en double", updatedAt: voidedAt };
          data.obligations.push(voided);
          command(voidCmd, "voidObligation", voidedAt, { obligationId: posted.id });
          audit(voidCmd, 1, voidedAt, { action: "obligation.void", entityType: "obligation", entityId: posted.id, reason: "Saisie en double", before: structuredClone(posted), after: structuredClone(voided) });
        } else {
          data.obligations.push(posted);
          if (state === "posted") {
            outstanding.set(posted.id, principal);
            open.set(posted.id, { obligation: posted, outstanding: principal });
          }
        }
        continue;
      }

      if (kind === "payment") {
        const buckets = new Map<string, OpenEntry[]>();
        for (const e of open.values()) {
          const key = `${e.obligation.direction}|${e.obligation.currency}`;
          const list = buckets.get(key);
          if (list) list.push(e);
          else buckets.set(key, [e]);
        }
        const [direction, currency] = rng.pick([...buckets.keys()]).split("|") as [Direction, CurrencyCode];
        const list = buckets.get(`${direction}|${currency}`)!;
        const total = list.reduce((n, e) => n + e.outstanding, 0);
        const advance = rng.chance(0.005);
        let amount: number;
        if (advance) amount = total + (currency === "EUR" ? 50_00 : 1_000_00);
        else if (rng.chance(0.35)) amount = total;
        else {
          const unit = currency === "EUR" ? 100 : 100_00; // whole euros, or 100 DA steps
          amount = Math.floor((total * (0.1 + 0.8 * rng.next())) / unit) * unit;
          if (amount <= 0) amount = total;
        }
        // Oldest-due-first, exactly as the recordPayment handler plans it.
        const { lines } = planAllocation(list, amount);
        const cmd = nextCmd();
        const createdAt = stamp(date);
        const method = rng.weighted(METHOD_WEIGHTS);
        const payment: Payment = {
          id: `pay_${cmd}`,
          workspaceId: WS_ID,
          partyId: party.id,
          direction,
          currency,
          amount,
          date,
          method,
          methodLabel: "",
          reference: method === "bank_transfer" ? `VIR-${pad(rng.int(1, 999_999), 6)}` : method === "ccp_baridimob" ? `CCP-${pad(rng.int(1, 999_999), 6)}` : "",
          note: "",
          allowAdvance: advance,
          state: "posted",
          reversedAt: null,
          reversalReason: null,
          receiptNumber: `R-${pad(++receiptSeq, 5)}`,
          attachmentIds: [],
          createdAt,
          createdBy: "owner",
        };
        command(cmd, "recordPayment", createdAt, { paymentId: payment.id, allocations: lines, unallocated: amount - lines.reduce((n, l) => n + l.amount, 0), receiptNumber: payment.receiptNumber });
        audit(cmd, 1, createdAt, { action: "payment.post", entityType: "payment", entityId: payment.id, after: { payment: structuredClone(payment), allocations: lines } });
        const reversed = !advance && rng.chance(0.006);
        const reversedAt = reversed ? stamp(minDate(addDays(date, 1), TODAY)) : null;
        lines.forEach((line, k) =>
          data.allocations.push({
            id: `alc_${payment.id}_${k + 1}`,
            workspaceId: WS_ID,
            paymentId: payment.id,
            obligationId: line.obligationId,
            partyId: party.id,
            amount: line.amount,
            date,
            reversedAt,
            createdAt,
          }),
        );
        if (reversed && reversedAt) {
          const revCmd = nextCmd();
          const after: Payment = { ...payment, state: "reversed", reversedAt, reversalReason: "Paiement saisi par erreur" };
          data.payments.push(after);
          command(revCmd, "reversePayment", reversedAt, { paymentId: payment.id, restored: lines });
          audit(revCmd, 1, reversedAt, {
            action: "payment.reverse",
            entityType: "payment",
            entityId: payment.id,
            reason: "Paiement saisi par erreur",
            before: structuredClone(payment),
            after: { reversedAllocations: lines.map((_, k) => `alc_${payment.id}_${k + 1}`) },
          });
        } else {
          data.payments.push(payment);
          for (const line of lines) {
            const e = open.get(line.obligationId)!;
            e.outstanding -= line.amount;
            outstanding.set(line.obligationId, e.outstanding);
            if (e.outstanding === 0) open.delete(line.obligationId);
          }
        }
        continue;
      }

      // Adjustment on a random open obligation of this party.
      const e = rng.pick([...open.values()]);
      const type = rng.weighted(ADJ_WEIGHTS);
      let amount: number;
      if (type === "increase") amount = Math.max(100, Math.round((e.obligation.principal * (0.05 + 0.15 * rng.next())) / 100) * 100);
      else {
        amount = (type === "waiver" || type === "write_off") && rng.chance(0.5) ? e.outstanding : Math.floor((e.outstanding * (0.1 + 0.5 * rng.next())) / 100) * 100;
        if (amount <= 0) amount = e.outstanding;
      }
      const cmd = nextCmd();
      const createdAt = stamp(date);
      const adj: Adjustment = {
        id: `adj_${cmd}`,
        workspaceId: WS_ID,
        obligationId: e.obligation.id,
        partyId: party.id,
        type,
        amount,
        date,
        reason: rng.pick(ADJ_REASONS),
        nettingId: null,
        reversedAt: null,
        createdAt,
        createdBy: "owner",
      };
      data.adjustments.push(adj);
      command(cmd, "adjustObligation", createdAt, { adjustmentId: adj.id });
      audit(cmd, 1, createdAt, { action: `adjustment.${type}`, entityType: "adjustment", entityId: adj.id, reason: adj.reason, after: structuredClone(adj) });
      e.outstanding += type === "increase" ? amount : -amount;
      outstanding.set(e.obligation.id, e.outstanding);
      if (e.outstanding === 0) open.delete(e.obligation.id);
    }
    movementsByParty.set(party.id, movements);
  }
  ws.settings.receipts.nextNumber = receiptSeq + 1;

  // Collections data on top of the final balances: installment plans, promises, reminders.
  const idx = buildIndex(data, WS_ID);
  const openDzdRec = [...idx.obligation.values()].filter(
    (o) => o.state === "posted" && o.direction === "receivable" && o.currency === "DZD" && !o.disputed && figuresOf(idx, o).outstanding >= 30_000_00,
  );
  const planned = new Set<string>();
  for (let n = 0; n < 150 && openDzdRec.length; n++) {
    const ob = openDzdRec.splice(rng.int(0, openDzdRec.length - 1), 1)[0];
    if (planned.has(ob.id)) continue;
    planned.add(ob.id);
    const f = figuresOf(idx, ob);
    let startDate = addDays(TODAY, -rng.int(0, 75));
    if (startDate < ob.date) startDate = ob.date;
    const cmd = nextCmd();
    const createdAt = stamp(minDate(startDate, TODAY));
    const plan: InstallmentPlan = {
      id: `ipl_${cmd}`,
      workspaceId: WS_ID,
      obligationId: ob.id,
      partyId: ob.partyId,
      frequency: "monthly",
      items: buildSchedule({ total: f.outstanding, frequency: "monthly", count: rng.int(3, 6), startDate }),
      total: f.outstanding,
      baseSettled: f.settled,
      state: "active",
      supersedesId: null,
      supersededById: null,
      reason: "Échéancier convenu",
      createdAt,
    };
    data.installmentPlans.push(plan);
    command(cmd, "createInstallmentPlan", createdAt, { installmentPlanId: plan.id });
    audit(cmd, 1, createdAt, { action: "installments.create", entityType: "installmentPlan", entityId: plan.id, reason: plan.reason, after: structuredClone(plan) });
  }

  const debtors = idx.parties
    .map((p) => ({ p, bal: partyBalance(idx, p.id, TODAY).get("DZD")?.receivable ?? 0 }))
    .filter((x) => x.bal > 0);
  for (let n = 0; n < 300; n++) {
    const { p, bal } = rng.pick(debtors);
    const madeOn = addDays(TODAY, -rng.int(1, 20));
    const cmd = nextCmd();
    const createdAt = stamp(madeOn);
    const promise: PromiseToPay = {
      id: `prm_${cmd}`,
      workspaceId: WS_ID,
      partyId: p.id,
      obligationId: null,
      currency: "DZD",
      amount: Math.min(bal, rng.int(5, 50) * 1_000_00),
      promisedDate: addDays(madeOn, rng.int(1, 25)),
      note: "",
      madeOn,
      cancelledAt: rng.chance(0.05) ? stamp(TODAY) : null,
      createdAt,
    };
    data.promises.push(promise);
    command(cmd, "createPromise", createdAt, { promiseId: promise.id });
    audit(cmd, 1, createdAt, { action: "promise.create", entityType: "promise", entityId: promise.id, after: structuredClone(promise) });
  }
  const CHANNELS: readonly (readonly [ReminderChannel, number])[] = [["whatsapp", 70], ["sms", 20], ["copy", 10]];
  const STATUSES: readonly (readonly [ReminderStatus, number])[] = [["opened_for_sharing", 50], ["marked_sent", 30], ["prepared", 15], ["failed", 5]];
  for (let n = 0; n < 2500; n++) {
    const { p, bal } = rng.pick(debtors);
    const cmd = nextCmd();
    const createdAt = stamp(addDays(TODAY, -rng.int(0, 90)));
    const status = rng.weighted(STATUSES);
    const language = rng.chance(0.7) ? "fr" : "ar";
    const log: ReminderLog = {
      id: `rem_${cmd}`,
      workspaceId: WS_ID,
      partyId: p.id,
      channel: rng.weighted(CHANNELS),
      language,
      message: language === "fr" ? `Bonjour ${p.displayName}, il reste ${bal / 100} DA à régler. Merci.` : `السلام عليكم ${p.displayName}، يبقى ${bal / 100} دج. شكرا.`,
      amounts: [{ currency: "DZD", amount: bal }],
      status,
      history: status === "prepared" ? [{ status, at: createdAt }] : [{ status: "prepared", at: createdAt }, { status, at: createdAt }],
      createdAt,
    };
    data.reminders.push(log);
    command(cmd, "logReminder", createdAt, { reminderId: log.id, amounts: log.amounts });
  }
  return { data, commands, outstanding, movementsByParty, phoneOfParty };
}

// ---------------------------------------------------------------- timing helpers

type Row = { group: string; name: string; runs: number; warmup: number; medianMs: number; minMs: number; maxMs: number; result: string; note?: string };
const rows: Row[] = [];
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function bench<T>(
  group: string,
  name: string,
  fn: () => T | Promise<T>,
  opts: { runs?: number; warmup?: number; note?: string; describe?: (r: T) => string } = {},
): Promise<T> {
  const runs = opts.runs ?? FAST_RUNS;
  const warmup = opts.warmup ?? 1;
  let last: T | undefined;
  for (let i = 0; i < warmup; i++) last = await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const out = fn();
    last = out instanceof Promise ? await out : out;
    times.push(performance.now() - t0);
  }
  const row: Row = {
    group,
    name,
    runs,
    warmup,
    medianMs: r3(median(times)),
    minMs: r3(Math.min(...times)),
    maxMs: r3(Math.max(...times)),
    result: opts.describe ? opts.describe(last as T) : "",
    note: opts.note,
  };
  rows.push(row);
  process.stdout.write(`  ${name}: median ${row.medianMs.toFixed(2)} ms\n`);
  return last as T;
}

async function timeOnce<T>(fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: r3(performance.now() - t0), value };
}

function searchSummary(m: PartyMatch[]) {
  const by: Record<string, number> = {};
  for (const x of m) by[x.reason] = (by[x.reason] ?? 0) + 1;
  return `${m.length} matches ${JSON.stringify(by)}`;
}

/** Records of the given parties only (plus the workspace and its audit trail for them). */
function subsetLedger(data: LedgerData, partyIds: Set<string>): LedgerData {
  const out = emptyLedger();
  out.workspaces = data.workspaces;
  out.parties = data.parties.filter((p) => partyIds.has(p.id));
  const byParty = <T extends { partyId: string }>(list: T[]) => list.filter((r) => partyIds.has(r.partyId));
  out.obligations = byParty(data.obligations);
  out.payments = byParty(data.payments);
  out.allocations = byParty(data.allocations);
  out.adjustments = byParty(data.adjustments);
  out.installmentPlans = byParty(data.installmentPlans);
  out.promises = byParty(data.promises);
  out.reminders = byParty(data.reminders);
  const kept = new Set<string>([WS_ID]);
  for (const s of ["parties", "obligations", "payments", "adjustments", "installmentPlans", "promises"] as const) for (const r of out[s]) kept.add(r.id);
  out.audit = data.audit.filter((a) => kept.has(a.entityId));
  return out;
}

const recordCount = (d: LedgerData) => DATA_STORES.reduce((n, s) => n + d[s].length, 0);

// ---------------------------------------------------------------- command throughput

type CommandResult = {
  store: string;
  label: string;
  command: string;
  n: number;
  preloadMs: number;
  loadAllMs: number;
  totalMs: number;
  perCommandMeanMs: number;
  perCommandMedianMs: number;
  perCommandP95Ms: number;
  perCommandMaxMs: number;
  validateIssuesAfter: number;
};

async function preload(store: Store, data: LedgerData, commands: CommandRecord[]) {
  await store.run("readwrite", async (tx) => {
    const pending: Promise<void>[] = [];
    for (const s of DATA_STORES) for (const r of data[s] as never[]) pending.push(tx.put(s, r));
    for (const c of commands) pending.push(tx.put("commands", c));
    await Promise.all(pending);
  });
}

async function runCommands(store: Store, prefix: string, type: string, payloads: Record<string, unknown>[]) {
  const per: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < payloads.length; i++) {
    const c0 = performance.now();
    await execute(store, { id: `bench_${prefix}_${pad(i, 4)}`, type, payload: payloads[i] }, () => NOW);
    per.push(performance.now() - c0);
  }
  const total = performance.now() - t0;
  return { total, per };
}

async function commandSuite(storeName: string, label: string, store: Store, gen: Generated, paymentPayloads: Record<string, unknown>[], obligationPayloads: Record<string, unknown>[]): Promise<CommandResult[]> {
  console.log(`\n[commands] ${storeName}: preloading ${recordCount(gen.data) + gen.commands.length} records...`);
  const pre = await timeOnce(() => preload(store, gen.data, gen.commands));
  const load = await timeOnce(() => loadLedger(store));
  if (recordCount(load.value) !== recordCount(gen.data)) throw new Error(`${storeName}: preload count mismatch`);
  const out: CommandResult[] = [];
  for (const [type, payloads] of [["recordPayment", paymentPayloads], ["createObligation", obligationPayloads]] as const) {
    console.log(`[commands] ${storeName}: ${payloads.length} × ${type}...`);
    const { total, per } = await runCommands(store, `${storeName}_${type}`, type, payloads);
    const after = await loadLedger(store);
    const issues = validateLedger(after).length;
    out.push({
      store: storeName,
      label,
      command: type,
      n: payloads.length,
      preloadMs: pre.ms,
      loadAllMs: load.ms,
      totalMs: r3(total),
      perCommandMeanMs: r3(total / payloads.length),
      perCommandMedianMs: r3(median(per)),
      perCommandP95Ms: r3(percentile(per, 95)),
      perCommandMaxMs: r3(Math.max(...per)),
      validateIssuesAfter: issues,
    });
    console.log(`  mean ${(total / payloads.length).toFixed(2)} ms/command, validate issues after: ${issues}`);
  }
  return out;
}

// ---------------------------------------------------------------- main

async function main() {
  const cpus = os.cpus();
  const environment = {
    runAt: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    osVersion: os.version(),
    cpuModel: cpus[0]?.model.trim() ?? "unknown",
    logicalCores: cpus.length,
    totalMemGiB: r3(os.totalmem() / 1024 ** 3),
    freeMemGiBAtStart: r3(os.freemem() / 1024 ** 3),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    gcExposed: typeof (globalThis as { gc?: unknown }).gc === "function",
  };
  console.log("# Nsalek core benchmark\n");
  console.log(`Node ${environment.node} on ${environment.platform}/${environment.arch} (${environment.osVersion}), ${environment.cpuModel}, ${environment.logicalCores} logical cores, ${environment.totalMemGiB} GiB RAM\n`);

  // ---- dataset
  console.log("[dataset] generating...");
  const genT = await timeOnce(() => generate());
  const gen = genT.value;
  const { data } = gen;
  const counts = Object.fromEntries(DATA_STORES.map((s) => [s, data[s].length])) as Record<string, number>;
  const movements = data.obligations.length + data.payments.length + data.adjustments.length;
  console.log(`[dataset] ${data.parties.length} parties, ${movements} movements (${data.obligations.length} obligations, ${data.payments.length} payments, ${data.adjustments.length} adjustments), ${data.allocations.length} allocations, ${data.audit.length} audit events, generated in ${genT.ms.toFixed(0)} ms`);

  const validation = await timeOnce(() => validateLedger(data));
  console.log(`[dataset] validateLedger: ${validation.value.length} issues`);
  if (validation.value.length) {
    console.error(validation.value.slice(0, 20));
    process.exit(1);
  }
  // Independent cross-check: the core's derived outstanding equals the simulated one.
  const idx0 = buildIndex(data, WS_ID);
  let mismatches = 0;
  for (const [id, expected] of gen.outstanding) if (figuresOf(idx0, idx0.obligation.get(id)!).outstanding !== expected) mismatches++;
  console.log(`[dataset] outstanding cross-check: ${mismatches} mismatches over ${gen.outstanding.size} posted obligations`);
  if (mismatches) process.exit(1);
  if (movements !== MOVEMENT_TARGET || data.parties.length !== PARTY_COUNT) {
    console.error("dataset size differs from target");
    process.exit(1);
  }

  const obs = data.obligations;
  const posted = obs.filter((o) => o.state === "posted");
  const openPosted = posted.filter((o) => figuresOf(idx0, o).outstanding > 0);
  const [heaviestId, heaviestCount] = [...gen.movementsByParty].sort((a, b) => b[1] - a[1])[0];
  const movementCounts = [...gen.movementsByParty.values()].sort((a, b) => a - b);
  const dataset = {
    seed: SEED,
    clock: NOW.toISOString(),
    today: TODAY,
    workspace: { id: WS_ID, currency: "DZD", mode: "business", timezone: "Africa/Algiers" },
    counts,
    totalRecords: recordCount(data),
    commandRecords: gen.commands.length,
    movements: { total: movements, obligations: obs.length, payments: data.payments.length, adjustments: data.adjustments.length },
    parties: {
      total: data.parties.length,
      persons: data.parties.filter((p) => p.kind === "person").length,
      organizations: data.parties.filter((p) => p.kind === "organization").length,
      withPhone: data.parties.filter((p) => p.phones.length).length,
      withTags: data.parties.filter((p) => p.tags.length).length,
      archived: data.parties.filter((p) => p.archivedAt).length,
      snoozed: data.parties.filter((p) => p.snoozedUntil).length,
      movementsPerParty: { min: movementCounts[0], median: median(movementCounts), max: movementCounts[movementCounts.length - 1] },
    },
    obligations: {
      posted: posted.length,
      draft: obs.filter((o) => o.state === "draft").length,
      voided: obs.filter((o) => o.state === "voided").length,
      receivable: obs.filter((o) => o.direction === "receivable").length,
      payable: obs.filter((o) => o.direction === "payable").length,
      dzd: obs.filter((o) => o.currency === "DZD").length,
      eur: obs.filter((o) => o.currency === "EUR").length,
      withDueDate: obs.filter((o) => o.dueDate).length,
      dueInPast: obs.filter((o) => o.dueDate && o.dueDate < TODAY).length,
      dueTodayOrFuture: obs.filter((o) => o.dueDate && o.dueDate >= TODAY).length,
      disputed: obs.filter((o) => o.disputed).length,
      openPosted: openPosted.length,
      openOverdue: openPosted.filter((o) => o.dueDate && o.dueDate < TODAY).length,
    },
    payments: {
      posted: data.payments.filter((p) => p.state === "posted").length,
      reversed: data.payments.filter((p) => p.state === "reversed").length,
      withAdvance: data.payments.filter((p) => p.allowAdvance).length,
      eur: data.payments.filter((p) => p.currency === "EUR").length,
    },
    allocations: { active: data.allocations.filter((a) => !a.reversedAt).length, reversed: data.allocations.filter((a) => a.reversedAt).length },
    adjustments: Object.fromEntries(["increase", "decrease", "waiver", "write_off"].map((t) => [t, data.adjustments.filter((a) => a.type === t).length])),
    heaviestParty: { id: heaviestId, movements: heaviestCount },
    generationMs: genT.ms,
    validateLedgerIssues: validation.value.length,
    outstandingCrossCheckMismatches: mismatches,
    payloadSha256: "",
  };
  const heap = process.memoryUsage();
  const memoryAfterGeneration = { heapUsedMiB: r3(heap.heapUsed / 1024 ** 2), rssMiB: r3(heap.rss / 1024 ** 2) };

  // ---- derived views
  const settings = data.workspaces[0].settings;
  console.log("\n[core] derived views");
  const idx: LedgerIndex = await bench("Index & balances", "buildIndex", () => buildIndex(data, WS_ID), { describe: (i) => `${i.obligation.size} obligations, ${i.payment.size} payments indexed` });
  await bench("Index & balances", "workspaceTotals", () => workspaceTotals(idx, TODAY), {
    describe: (t) => [...t].map(([c, b]) => `${c}: receivable ${b.receivable} / payable ${b.payable} minor`).join("; "),
  });
  await bench("Index & balances", "partyBalance × 1,000 parties", () => idx.parties.map((p) => partyBalance(idx, p.id, TODAY)), { describe: (l) => `${l.length} balances` });

  // Search inputs taken from the generated data so each query has real matches.
  const phoneParty = data.parties[500 + [...data.parties.slice(500)].findIndex((p) => p.phones.length)];
  const key = phoneKey(phoneParty.phones[0]); // 9 digits, e.g. 5500xxxxx
  const phoneFragment = key.slice(-6);
  const domesticPrefix = "0" + key.slice(0, 7); // how the same number starts when typed as 05 50 0x xx ...
  const amountOb = posted.filter((o) => o.currency === "DZD")[1000];
  const amountQuery = String(amountOb.principal / 100);
  const filtered: PartyFilters = { direction: "receivable", due: "overdue" };
  console.log("\n[core] search");
  await bench("Search", `searchParties name "ben"`, () => searchParties(idx, "ben", {}, TODAY), { describe: searchSummary });
  await bench("Search", `searchParties phone fragment "${phoneFragment}"`, () => searchParties(idx, phoneFragment, {}, TODAY), { describe: searchSummary });
  await bench("Search", `searchParties domestic phone prefix "${domesticPrefix}"`, () => searchParties(idx, domesticPrefix, {}, TODAY), {
    describe: (m) => `${searchSummary(m)}; expected party ${phoneParty.id} ${m.some((x) => x.party.id === phoneParty.id) ? "found" : "NOT found"}`,
  });
  await bench("Search", `searchParties amount "${amountQuery}"`, () => searchParties(idx, amountQuery, {}, TODAY), { describe: searchSummary });
  await bench("Search", `searchParties "" + {receivable, overdue}`, () => searchParties(idx, "", filtered, TODAY), { describe: searchSummary });
  // Attribution: a party that does not match by name/phone/amount falls through to normalizeText()
  // on every posted obligation's description + reference, on every keystroke.
  const searchTexts = posted.map((o) => o.description + " " + o.reference);
  await bench("Search", `normalizeText × ${searchTexts.length} obligation description+reference (text fallback)`, () => searchTexts.reduce((n, t) => n + normalizeText(t).length, 0), {
    describe: (n) => `${n} normalized chars`,
  });

  console.log("\n[core] statement, collections, reports");
  await bench("Statement", `partyEffects (heaviest party, ${heaviestCount} movements)`, () => partyEffects(idx, heaviestId), { describe: (e) => `${e.length} effects` });
  await bench("Statement", "buildStatement DZD 2026-01-01..today (heaviest party)", () => buildStatement(idx, heaviestId, "DZD", "2026-01-01", TODAY), {
    describe: (s) => s.sections.map((x) => `${x.direction}: ${x.rows.length} rows, closing ${x.closing}`).join("; "),
  });
  await bench("Collections", "agingReport receivable", () => agingReport(idx, TODAY, settings, "receivable"), {
    describe: (r) => [...r].map(([c, v]) => `${c}: ${v.buckets.reduce((n, b) => n + b.count, 0) + v.notDue.count + v.noDueDate.count} open`).join("; "),
  });
  await bench("Collections", "agingReport payable", () => agingReport(idx, TODAY, settings, "payable"), {
    describe: (r) => [...r].map(([c, v]) => `${c}: ${v.buckets.reduce((n, b) => n + b.count, 0) + v.notDue.count + v.noDueDate.count} open`).join("; "),
  });
  await bench("Collections", "overdueList receivable", () => overdueList(idx, TODAY), { describe: (l) => `${l.length} overdue debts` });
  await bench("Collections", "reminderQueue", () => reminderQueue(idx, TODAY, settings), { describe: (l) => `${l.length} parties queued` });
  await bench("Collections", "dailyActions", () => dailyActions(idx, TODAY), { describe: (l) => `${l.length} actions` });
  const yearFrom = addDays(TODAY, -364);
  await bench("Reports", `periodReport ${yearFrom}..${TODAY}`, () => periodReport(idx, yearFrom, TODAY), {
    describe: (m) => [...m.values()].map((r) => `${r.currency}: ${r.counts.obligations} obligations, ${r.counts.payments} payments`).join("; "),
  });
  await bench("Reports", "perPartyBalances", () => perPartyBalances(idx, TODAY), { describe: (l) => `${l.length} rows` });
  await bench("Integrity", "validateLedger", () => validateLedger(data), { describe: (l) => `${l.length} issues` });

  // ---- backups
  console.log("\n[backup]");
  const plain = await bench("Backup", "createBackup (unencrypted)", () => createBackup(data, { now: NOW }), { runs: SLOW_RUNS, describe: (f) => `payload sha256 ${f.manifest.payloadSha256.slice(0, 12)}…` });
  dataset.payloadSha256 = plain.manifest.payloadSha256;
  const plainText = await bench("Backup", "serializeBackup (unencrypted)", () => serializeBackup(plain), { runs: SLOW_RUNS, describe: (t) => `${Buffer.byteLength(t, "utf8")} bytes` });
  const enc = await bench("Backup", `createBackup (encrypted, PBKDF2 ${PBKDF2_ITERATIONS} iterations)`, () => createBackup(data, { now: NOW, passphrase: PASSPHRASE }), {
    runs: SLOW_RUNS,
    describe: (f) => `iterations in envelope: ${f.encryption?.iterations}`,
  });
  const encText = serializeBackup(enc);
  await bench("Backup", "parseBackup + openBackup (encrypted)", async () => openBackup(parseBackup(encText), PASSPHRASE), { runs: SLOW_RUNS, describe: (d) => `${recordCount(d)} records restored in memory` });
  await bench("Backup", "parseBackup + openBackup (unencrypted)", async () => openBackup(parseBackup(plainText)), { runs: SLOW_RUNS, describe: (d) => `${recordCount(d)} records restored in memory` });
  const backupSize = {
    unencryptedBytes: Buffer.byteLength(plainText, "utf8"),
    encryptedBytes: Buffer.byteLength(encText, "utf8"),
    unencryptedMB: r3(Buffer.byteLength(plainText, "utf8") / 1e6),
    encryptedMB: r3(Buffer.byteLength(encText, "utf8") / 1e6),
    pbkdf2Iterations: PBKDF2_ITERATIONS,
  };
  console.log(`  backup size: ${backupSize.unencryptedMB} MB unencrypted, ${backupSize.encryptedMB} MB encrypted (1 MB = 10^6 bytes)`);

  // Attribution of the backup cost to its steps (same primitives backup.ts / crypto.ts use).
  console.log("\n[backup] breakdown");
  const json = await bench("Backup breakdown", "canonical(sortLedger(data))", () => canonical(sortLedger(data)), { runs: SLOW_RUNS, describe: (s) => `${s.length} chars` });
  await bench("Backup breakdown", "sha256Hex(payload JSON)", () => sha256Hex(json), { runs: SLOW_RUNS });
  await bench("Backup breakdown", "JSON.parse(payload JSON)", () => JSON.parse(json) as unknown, { runs: SLOW_RUNS });
  const subtle = globalThis.crypto.subtle;
  // Fixed salt/IV are fine here: this key and ciphertext only exist to time the primitives.
  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  const derive = async () => {
    const base = await subtle.importKey("raw", new TextEncoder().encode(PASSPHRASE), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  };
  const aesKey = await bench("Backup breakdown", `PBKDF2-SHA-256 key derivation (${PBKDF2_ITERATIONS} iterations)`, derive, { runs: SLOW_RUNS });
  const plainBytes = new TextEncoder().encode(json);
  const cipher = await bench("Backup breakdown", "AES-GCM-256 encrypt (payload bytes)", async () => new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plainBytes)), {
    runs: SLOW_RUNS,
    describe: (c) => `${c.length} bytes`,
  });
  const cipherB64 = await bench("Backup breakdown", "bytesToBase64(ciphertext)", () => bytesToBase64(cipher), { runs: SLOW_RUNS, describe: (s) => `${s.length} chars` });
  await bench("Backup breakdown", "base64ToBytes(ciphertext)", () => base64ToBytes(cipherB64), { runs: SLOW_RUNS });
  await bench("Backup breakdown", "AES-GCM-256 decrypt (payload bytes)", () => subtle.decrypt({ name: "AES-GCM", iv }, aesKey, cipher), { runs: SLOW_RUNS });

  // ---- restore validation (prepareRestore loads into a temporary MemoryStore)
  console.log("\n[restore] prepareRestore on subsets of the dataset (single run each)");
  const restore: { parties: number; records: number; ms: number; issues: number; manifestOk: boolean }[] = [];
  const sizes = FULL_RESTORE ? [50, 100, 200, PARTY_COUNT] : [50, 100, 200];
  for (const n of sizes) {
    const subset = n === PARTY_COUNT ? data : subsetLedger(data, new Set(data.parties.slice(0, n).map((p) => p.id)));
    const file = await createBackup(subset, { now: NOW });
    const t = await timeOnce(() => prepareRestore(file));
    restore.push({ parties: n, records: recordCount(subset), ms: t.ms, issues: t.value.issues.length, manifestOk: t.value.manifestOk });
    console.log(`  ${n} parties / ${recordCount(subset)} records: ${t.ms.toFixed(0)} ms (issues ${t.value.issues.length}, manifest ${t.value.manifestOk ? "ok" : "MISMATCH"})`);
  }

  // ---- command throughput
  const candidates = idx.parties
    .filter((p) => !p.mergedIntoId)
    .map((p) => ({ p, bal: partyBalance(idx, p.id, TODAY).get("DZD")?.receivable ?? 0 }))
    .filter((x) => x.bal >= 1_000_00);
  const capacity = new Map(candidates.map((c) => [c.p.id, Math.floor(c.bal / 100_00)]));
  const paymentPayloads: Record<string, unknown>[] = [];
  for (let i = 0; paymentPayloads.length < COMMAND_N; i++) {
    const c = candidates[i % candidates.length];
    const left = capacity.get(c.p.id)!;
    if (left <= 0) continue;
    capacity.set(c.p.id, left - 1);
    paymentPayloads.push({ workspaceId: WS_ID, partyId: c.p.id, direction: "receivable", currency: "DZD", amount: 100_00, method: "cash" });
  }
  const active = idx.parties.filter((p) => !p.archivedAt && !p.mergedIntoId);
  const obligationPayloads = Array.from({ length: COMMAND_N }, (_, i) => ({
    workspaceId: WS_ID,
    partyId: active[(i * 7) % active.length].id,
    direction: "receivable",
    currency: "DZD",
    principal: 2_500_00,
    date: TODAY,
    dueDate: addDays(TODAY, 30),
    description: "Benchmark",
  }));

  const commandResults: CommandResult[] = [];
  const mem = new MemoryStore();
  commandResults.push(...(await commandSuite("MemoryStore", "MemoryStore (in-process Map store used by tests and restore validation)", mem, gen, paymentPayloads, obligationPayloads)));
  const idb = await openStore("nsalek-bench", new IDBFactory());
  commandResults.push(...(await commandSuite("fake-indexeddb", "fake-indexeddb in Node — NOT representative of browser IndexedDB", idb, gen, paymentPayloads, obligationPayloads)));
  idb.close();

  // ---- output
  const day = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local date of the run
  const outDir = fileURLToPath(new URL("../bench-results/", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  const outFile = `${outDir}node-${day}.json`;
  const report = {
    tool: "scripts/bench.ts",
    environment,
    dataset,
    memoryAfterGeneration,
    timing: { method: "performance.now(); median/min/max over `runs` timed runs after `warmup` untimed runs", fastRuns: FAST_RUNS, slowRuns: SLOW_RUNS },
    results: rows,
    backupSize,
    prepareRestore: { note: "single run per size; prepareRestore = openBackup + load into a temporary MemoryStore + readAll + validateLedger + manifestMatches", runs: restore },
    commands: {
      note: "N sequential execute() calls, each its own read-write transaction, against a store preloaded with the full dataset plus its command records. Payments: 100 DA, auto-allocated. Obligations: 2,500 DA, due in 30 days.",
      results: commandResults,
    },
  };
  writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");

  const lines: string[] = [];
  lines.push("\n## Results\n");
  lines.push(`Dataset: ${data.parties.length} parties, ${movements} movements (${obs.length} obligations, ${data.payments.length} payments, ${data.adjustments.length} adjustments), ${data.allocations.length} allocations, ${data.audit.length} audit events; validateLedger issues: ${validation.value.length}.\n`);
  lines.push("| Group | Operation | Median ms | Min ms | Max ms | Runs | Result |");
  lines.push("|---|---|---:|---:|---:|---:|---|");
  for (const r of rows) lines.push(`| ${r.group} | ${r.name} | ${r.medianMs.toFixed(2)} | ${r.minMs.toFixed(2)} | ${r.maxMs.toFixed(2)} | ${r.runs} | ${r.result.replace(/\|/g, "/")} |`);
  lines.push(`\nBackup size: ${backupSize.unencryptedBytes} bytes (${backupSize.unencryptedMB} MB) unencrypted, ${backupSize.encryptedBytes} bytes (${backupSize.encryptedMB} MB) encrypted.\n`);
  lines.push("| prepareRestore | Records | ms (1 run) |");
  lines.push("|---|---:|---:|");
  for (const r of restore) lines.push(`| ${r.parties} parties | ${r.records} | ${r.ms.toFixed(1)} |`);
  lines.push("");
  lines.push("| Store | Command | N | Preload ms | loadLedger ms | Total ms | Mean ms/cmd | Median | p95 | Max | Issues after |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const c of commandResults)
    lines.push(`| ${c.label} | ${c.command} | ${c.n} | ${c.preloadMs.toFixed(0)} | ${c.loadAllMs.toFixed(0)} | ${c.totalMs.toFixed(0)} | ${c.perCommandMeanMs.toFixed(2)} | ${c.perCommandMedianMs.toFixed(2)} | ${c.perCommandP95Ms.toFixed(2)} | ${c.perCommandMaxMs.toFixed(2)} | ${c.validateIssuesAfter} |`);
  lines.push(`\nWritten ${outFile}`);
  console.log(lines.join("\n"));
}

await main();

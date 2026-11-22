// Deterministic, clearly labeled demo workspace. Synthetic names and 0550 00 00 0x style
// numbers only; no real people, customers or statements. Built through the same commands
// as real data, so every invariant holds.
import { addDays, todayIn } from "./core/dates.ts";
import type { Lang } from "./core/money.ts";

type Run = <T = Record<string, unknown>>(type: string, payload: Record<string, unknown>, id?: string) => Promise<T>;

const DA = (n: number) => Math.round(n * 100);

export async function seedDemo(run: Run, opts: { lang: Lang; mode: "personal" | "business"; today?: string }): Promise<string> {
  const today = opts.today ?? todayIn("Africa/Algiers");
  const d = (n: number) => addDays(today, n);
  const name = opts.lang === "ar" ? "دفتر تجريبي" : opts.lang === "fr" ? "Carnet de démonstration" : "Demo notebook";
  const { workspaceId: ws } = await run<{ workspaceId: string }>("createWorkspace", {
    name,
    mode: opts.mode,
    defaultCurrency: "DZD",
    timezone: "Africa/Algiers",
    country: "DZ",
    demo: true,
    business: { name: opts.mode === "business" ? "Quincaillerie El Amel (démo)" : "", phone: "0550 00 00 00", address: "Adrar (démo)" },
    settings: { invoices: { enabled: opts.mode === "business", prefix: "F-", nextNumber: 1, taxRates: [] } },
  });
  const person = async (displayName: string, extra: Record<string, unknown> = {}) =>
    (await run<{ partyId: string }>("createParty", { workspaceId: ws, displayName, allowDuplicate: true, ...extra })).partyId;
  const debt = async (partyId: string, direction: string, amount: number, date: string, extra: Record<string, unknown> = {}) =>
    (await run<{ obligationId: string }>("createObligation", { workspaceId: ws, partyId, direction, currency: "DZD", principal: DA(amount), date, ...extra })).obligationId;
  const pay = async (partyId: string, direction: string, amount: number, date: string, extra: Record<string, unknown> = {}) =>
    (await run<{ paymentId: string }>("recordPayment", { workspaceId: ws, partyId, direction, currency: "DZD", amount: DA(amount), date, method: "cash", ...extra })).paymentId;

  const karim = await person("Karim Benali", { phones: ["0550 00 00 01"], tags: ["voisin"] });
  const samira = await person("Samira Haddad", { phones: ["0550 00 00 02"] });
  const moussa = await person("Moussa Ouali", { phones: ["0550 00 00 03"], isCustomer: true });
  const nour = await person("Épicerie Nour", { kind: "organization", phones: ["0550 00 00 04"], isCustomer: true, isSupplier: true, tags: ["commerce"] });
  const yacine = await person("Yacine Belkacem", { phones: ["0550 00 00 05"] });
  const atlas = await person("Fournisseur Atlas", { kind: "organization", phones: ["0550 00 00 06"], isSupplier: true });
  const nadia = await person("Nadia Cherif", { phones: ["+33 6 00 00 00 07"] });
  const rachid = await person("Rachid Mansouri");

  // Karim: borrowed 10,000, repaid 2,500 then 1,500 (fixture A).
  await debt(karim, "receivable", 10_000, d(-45), { description: "Prêt / سلفة", dueDate: d(-15) });
  await pay(karim, "receivable", 2_500, d(-30));
  await pay(karim, "receivable", 1_500, d(-10), { method: "ccp_baridimob" });
  await run("createPromise", { workspaceId: ws, partyId: karim, currency: "DZD", amount: DA(3_000), promisedDate: today, note: "Après la paie" });

  // Samira: credit purchases, one overdue, one due this week.
  await debt(samira, "receivable", 4_200, d(-20), { description: "Courses", dueDate: d(-5) });
  await debt(samira, "receivable", 1_850, d(-3), { description: "Courses", dueDate: d(4) });

  // Moussa: 30,000 on installments, first one paid.
  const m1 = await debt(moussa, "receivable", 30_000, d(-35), { description: "Matériel", reference: "BL-1042" });
  await run("createInstallmentPlan", { obligationId: m1, frequency: "monthly", count: 3, startDate: d(-5) });
  await pay(moussa, "receivable", 10_000, d(-6), { method: "bank_transfer" });

  // Épicerie Nour: both customer and supplier → shown on both sides, never netted silently.
  await debt(nour, "receivable", 12_000, d(-25), { description: "Livraison ciment", dueDate: d(-1) });
  await debt(nour, "payable", 5_000, d(-18), { description: "Achat sucre" });

  // Yacine: disputed amount, paused from reminders.
  const y1 = await debt(yacine, "receivable", 2_000, d(-40), { dueDate: d(-30), description: "Réparation" });
  await run("setDispute", { obligationId: y1, disputed: true, note: "Conteste le montant" });

  // Supplier: what I owe, partly paid.
  await debt(atlas, "payable", 45_000, d(-28), { description: "Stock", dueDate: d(2) });
  await pay(atlas, "payable", 15_000, d(-14), { method: "bank_transfer" });

  // Nadia: a EUR debt kept separate from DZD.
  await run("createObligation", { workspaceId: ws, partyId: nadia, direction: "receivable", currency: "EUR", principal: 12_000, date: d(-12), description: "Billet d'avion" });

  // Rachid: paid in full, with a reversed duplicate entry and a small waiver.
  const r1 = await debt(rachid, "receivable", 3_000, d(-50), { dueDate: d(-40) });
  await pay(rachid, "receivable", 2_800, d(-38));
  const dup = await pay(rachid, "receivable", 200, d(-37));
  await run("reversePayment", { paymentId: dup, reason: "Saisie en double" });
  await run("adjustObligation", { obligationId: r1, type: "waiver", amount: DA(200), reason: "Geste commercial", date: d(-36) });

  // Monthly rent I am owed (recurring), generated for elapsed months.
  await run("createRecurringPlan", { workspaceId: ws, partyId: samira, direction: "receivable", currency: "DZD", amount: DA(15_000), description: "Loyer garage", frequency: "monthly", startDate: d(-62), dueAfterDays: 5 });
  await run("generateRecurring", { workspaceId: ws });
  return ws;
}

// Installment schedules describe how an existing debt will be repaid. Creating one never
// creates or increases a debt.
import { addDays, addMonthsAnchored, isISODate } from "./dates.ts";
import { check, type ISODate, type InstallmentItem, type InstallmentPlan, type Minor } from "./types.ts";

/**
 * Splits `total` into `count` parts. Every part is floor(total / count); the last part absorbs
 * the rounding residue so that the parts always sum to the total
 * (10 000,00 / 3 → 3 333,33 + 3 333,33 + 3 333,34).
 */
export function splitAmount(total: Minor, count: number): Minor[] {
  check(Number.isSafeInteger(total) && total > 0, "amount_positive");
  check(Number.isInteger(count) && count >= 1 && count <= 360, "installment_count");
  check(total >= count, "installment_too_small");
  const base = Math.floor(total / count);
  const parts = Array.from({ length: count }, () => base);
  parts[count - 1] = total - base * (count - 1);
  return parts;
}

export function scheduleDates(startDate: ISODate, count: number, frequency: "weekly" | "monthly"): ISODate[] {
  check(isISODate(startDate), "invalid_date");
  const anchor = +startDate.slice(8, 10);
  return Array.from({ length: count }, (_, i) =>
    frequency === "weekly" ? addDays(startDate, 7 * i) : addMonthsAnchored(startDate, i, anchor),
  );
}

export function buildSchedule(input: {
  total: Minor;
  frequency: "weekly" | "monthly" | "custom";
  count?: number;
  startDate?: ISODate;
  items?: { dueDate: ISODate; amount: Minor }[];
}): InstallmentItem[] {
  if (input.frequency === "custom") {
    const items = input.items ?? [];
    check(items.length >= 1 && items.length <= 360, "installment_count");
    let previous = "";
    items.forEach((it) => {
      check(isISODate(it.dueDate), "invalid_date");
      check(Number.isSafeInteger(it.amount) && it.amount > 0, "amount_positive");
      check(it.dueDate >= previous, "installment_order");
      previous = it.dueDate;
    });
    const sum = items.reduce((n, it) => n + it.amount, 0);
    check(sum === input.total, "installment_sum", { sum, total: input.total });
    return items.map((it, i) => ({ seq: i + 1, dueDate: it.dueDate, amount: it.amount }));
  }
  const count = input.count ?? 0;
  const amounts = splitAmount(input.total, count);
  const dates = scheduleDates(input.startDate ?? "", count, input.frequency);
  return amounts.map((amount, i) => ({ seq: i + 1, dueDate: dates[i], amount }));
}

export type InstallmentState = "paid" | "partly_paid" | "due" | "missed" | "upcoming";

export type InstallmentProgress = InstallmentItem & { covered: Minor; remaining: Minor; state: InstallmentState };

/**
 * Coverage is applied in sequence ("waterfall"): everything settled on the debt since the plan
 * was created covers installment 1 first, then 2, and so on. Early and partial payments work
 * the same way.
 */
export function installmentProgress(plan: InstallmentPlan, settledNow: Minor, today: ISODate): InstallmentProgress[] {
  let available = Math.max(0, settledNow - plan.baseSettled);
  return plan.items.map((it) => {
    const covered = Math.min(available, it.amount);
    available -= covered;
    const remaining = it.amount - covered;
    const state: InstallmentState =
      remaining === 0
        ? "paid"
        : it.dueDate < today
          ? "missed"
          : it.dueDate === today
            ? "due"
            : covered > 0
              ? "partly_paid"
              : "upcoming";
    return { ...it, covered, remaining, state };
  });
}

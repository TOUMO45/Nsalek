// Staff mode: the owner hands the phone to an employee. The employee records what happens in the
// shop (people, debts, repayments, cash, promises, reminders, notes, photos); corrections,
// cancellations, imports, settings and notebooks stay with the owner. Checked by the command
// engine itself, not only hidden on screen. It protects against mistakes and curiosity on a shared
// phone, not against someone who takes the phone apart: the PIN is a privacy screen.
export const STAFF_COMMANDS: ReadonlySet<string> = new Set([
  "createParty",
  "createObligation",
  "recordPayment",
  "createPromise",
  "logReminder",
  "updateReminderStatus",
  "addCashEntry",
  "addNote",
  "addAttachment",
  "snoozeParty",
  // Made by the app itself at each start; the same period never twice.
  "generateRecurring",
]);

export const STAFF = "staff";

export const staffMay = (commandType: string) => STAFF_COMMANDS.has(commandType);

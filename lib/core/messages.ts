// Reminder message drafts. The person always reviews and sends them from their own app.
import { formatMoney, type Lang } from "./money.ts";
import type { CurrencyCode, Minor } from "./types.ts";

export type MessageInput = {
  name: string;
  amounts: { currency: CurrencyCode; amount: Minor }[];
  business: string;
  dueDate?: string | null;
};

const list = (amounts: MessageInput["amounts"], lang: Lang) =>
  amounts.map((a) => formatMoney(a.amount, a.currency, lang)).join(lang === "ar" ? " و " : lang === "fr" ? " et " : " and ");

export function reminderMessage(lang: Lang, m: MessageInput): string {
  const total = list(m.amounts, lang);
  const signature = m.business ? `\n${m.business}` : "";
  if (lang === "ar")
    return `السلام عليكم ${m.name}،\nتذكير لطيف: المبلغ المتبقي هو ${total}.${m.dueDate ? `\nتاريخ الاستحقاق: ${m.dueDate}.` : ""}\nشكراً لتفهمكم.${signature}`;
  if (lang === "fr")
    return `Bonjour ${m.name},\nPetit rappel : le montant restant est de ${total}.${m.dueDate ? `\nÉchéance : ${m.dueDate}.` : ""}\nMerci de votre compréhension.${signature}`;
  return `Hello ${m.name},\nA friendly reminder: the remaining amount is ${total}.${m.dueDate ? `\nDue date: ${m.dueDate}.` : ""}\nThank you.${signature}`;
}

/** Generic notification text: no names, no amounts (shown on lock screens). */
export function genericNotification(lang: Lang, count: number, backupUrgent = false): { title: string; body: string } {
  const pick = (ar: string, fr: string, en: string) => (lang === "ar" ? ar : lang === "fr" ? fr : en);
  const parts: string[] = [];
  if (count) parts.push(pick(`لديك ${count} عناصر للمتابعة اليوم.`, `Vous avez ${count} élément(s) à suivre aujourd’hui.`, `You have ${count} item(s) to follow up today.`));
  if (backupUrgent) parts.push(pick("بياناتك بدون نسخة احتياطية حديثة.", "Vos données n’ont pas de sauvegarde récente.", "Your data has no recent backup."));
  return { title: lang === "ar" ? "نسالك" : "Nsalek", body: parts.join(" ") };
}

export function shareUrl(channel: "whatsapp" | "sms" | "email", phoneOrEmail: string, message: string, ios = false): string {
  const body = encodeURIComponent(message);
  if (channel === "whatsapp") return `https://wa.me/${phoneOrEmail.replace(/\D/g, "")}?text=${body}`;
  if (channel === "sms") return `sms:${encodeURIComponent(phoneOrEmail)}${ios ? "&" : "?"}body=${body}`;
  return `mailto:${encodeURIComponent(phoneOrEmail)}?body=${body}`;
}

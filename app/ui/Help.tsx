"use client";
import { useApp } from "@/lib/ui/state";

const HELP: Record<"ar" | "fr" | "en", { q: string; a: string }[]> = {
  ar: [
    { q: "ما الفرق بين «ليك» و«عليك»؟", a: "«ليك» (مستحق لك): مال يدين لك به شخص آخر. «عليك» (مستحق عليك): مال تدين به أنت. يُعرضان دائماً منفصلين، ولا يُخصم أحدهما من الآخر إلا بمقاصة صريحة تسجلها أنت." },
    { q: "كيف أسجل ديناً بسرعة؟", a: "اضغط «إضافة»، اختر الاتجاه، اكتب الاسم والمبلغ ثم «حفظ». تاريخ الاستحقاق والوصف والمرفقات اختيارية تحت «خيارات إضافية»." },
    { q: "كيف أسجل تسديداً؟", a: "من صفحة الشخص اضغط «تسجيل تسديد». يُوزَّع المبلغ تلقائياً على الأقدم استحقاقاً، ويمكنك تعديل التوزيع يدوياً. إذا كان المبلغ أكبر من الدين، يجب أن تختار صراحةً تسجيل الفائض كتسبيق." },
    { q: "أخطأت في مبلغ. كيف أصححه؟", a: "القيود المسجلة لا تُمسح. استعمل «تصحيح المبلغ» (زيادة، تخفيض، تنازل، شطب) مع سبب، أو «إلغاء القيد» إذا لم يكن عليه تسديد، أو «عكس التسديد». كل تصحيح يبقى في السجل." },
    { q: "المبالغ بالسنتيم؟", a: "اختر «سنتيم» بجانب حقل المبلغ: يُعرض التحويل إلى الدينار ويجب تأكيده قبل الحفظ. لا نفهم «ألف» أو «مليون» كتابةً؛ اكتب الأرقام." },
    { q: "التذكير عبر واتساب أو SMS", a: "من «المستحقات» ← «قائمة التذكير»: راجع الرسالة لكل شخص ثم افتحها في تطبيقك وأرسلها بنفسك. بعد الإرسال اضغط «تم الإرسال». لا يُرسل شيء تلقائياً، ولا نكتب «وصلت»." },
    { q: "الإدخال بالصوت", a: "اضغط الميكروفون وقل مثلاً «محمد دا ألفين دينار» أو «سمير خلصني خمسة آلاف دينار». إذا كان كل شيء واضحاً يُحفظ بعد 5 ثوانٍ ويمكنك الإلغاء. قل «دينار» أو «سنتيم» حتى لا يُسأل عن المبلغ. المتصفح يرسل الصوت إلى شركته لتحويله إلى نص، لذلك يحتاج إلى الإنترنت." },
    { q: "إذا ضاع الهاتف؟", a: "فعّل «نسخة احتياطية بلمسة واحدة» في المزيد ← النسخ الاحتياطي وأرسل النسخة إلى Drive أو واتساب. على الهاتف الجديد اضغط «عندي نسخة احتياطية» واكتب كلمة المرور." },
    { q: "أين تُحفظ بياناتي؟", a: "على هذا الجهاز فقط (IndexedDB في المتصفح). قد يحذفها المتصفح إذا مُسحت بيانات الموقع. نزّل نسخة احتياطية مشفرة بانتظام من «المزيد ← النسخ الاحتياطي». إذا نسيت كلمة المرور فلا يمكن فتح النسخة." },
    { q: "كشف الحساب PDF", a: "من صفحة الشخص ← «كشف حساب»: اختر الفترة واللغة ثم «طباعة / حفظ PDF» واختر «حفظ بصيغة PDF»." },
  ],
  fr: [
    { q: "« On me doit » ou « Je dois » ?", a: "« On me doit » (ليك) : l’argent qu’une autre personne vous doit. « Je dois » (عليك) : ce que vous devez. Les deux restent séparés ; rien n’est compensé sans une compensation explicite que vous enregistrez." },
    { q: "Enregistrer une dette rapidement", a: "Touchez « Ajouter », choisissez le sens, tapez le nom et le montant, puis « Enregistrer ». Échéance, description et pièces jointes sont facultatives (« Plus d’options »)." },
    { q: "Enregistrer un remboursement", a: "Sur la fiche de la personne, « Enregistrer un remboursement ». Le montant est affecté à l’échéance la plus ancienne ; vous pouvez ajuster à la main. Un excédent n’est accepté que si vous l’enregistrez explicitement comme avance." },
    { q: "Corriger une erreur", a: "Les écritures ne sont jamais effacées. Utilisez « Ajuster » (augmenter, diminuer, remise, perte) avec un motif, « Annuler l’écriture » s’il n’y a pas de remboursement, ou « Annuler le remboursement ». Chaque correction reste visible." },
    { q: "Montants en centimes", a: "Choisissez « centimes » à côté du montant : la conversion en DA s’affiche et doit être confirmée. Les mots « mille » ou « million » ne sont pas interprétés : tapez des chiffres." },
    { q: "Relances WhatsApp / SMS", a: "« Échéances » → « File de relance » : relisez chaque message, ouvrez-le dans votre application et envoyez-le vous-même, puis « Marquer envoyé ». Rien n’est envoyé automatiquement et rien n’est marqué « distribué »." },
    { q: "Saisie vocale", a: "Touchez le micro et dites par exemple « محمد دا ألفين دينار » ou « Samir m’a payé 5000 dinars ». Si tout est clair, l’écriture est enregistrée après 5 secondes et vous pouvez l’annuler. Dites « dinars » ou « centimes » pour éviter la question sur le montant. Le navigateur envoie l’audio à son éditeur pour le transcrire : il faut Internet." },
    { q: "Et si je perds le téléphone ?", a: "Activez « Sauvegarde en un geste » (Plus → Sauvegarde) et envoyez la copie vers Drive ou WhatsApp. Sur le nouveau téléphone, touchez « J’ai déjà une sauvegarde » et saisissez la phrase secrète." },
    { q: "Où sont mes données ?", a: "Uniquement sur cet appareil (IndexedDB du navigateur). Elles peuvent être effacées si les données du site sont supprimées. Téléchargez régulièrement une sauvegarde chiffrée (« Plus » → « Sauvegarde »). Une phrase secrète oubliée ne peut pas être récupérée." },
    { q: "Relevé PDF", a: "Fiche de la personne → « Relevé » : choisissez la période et la langue, puis « Imprimer / PDF » et « Enregistrer au format PDF »." },
  ],
  en: [
    { q: "“Owed to me” vs “I owe”", a: "Owed to me (ليك): money someone owes you. I owe (عليك): money you owe. They are always shown separately and never offset unless you record an explicit netting." },
    { q: "Record a debt fast", a: "Tap Add, pick the direction, type a name and an amount, then Save. Due date, description and attachments are optional under More options." },
    { q: "Record a repayment", a: "On the person’s page, Record repayment. It is allocated oldest-due first; you can adjust it manually. An excess is accepted only if you explicitly keep it as an advance." },
    { q: "Fix a mistake", a: "Entries are never erased. Use Adjust (increase, decrease, waive, write off) with a reason, Void entry when there is no repayment, or Reverse repayment. Every correction stays visible." },
    { q: "Voice entry", a: "Tap the microphone and say for example “محمد دا ألفين دينار” or “Samir paid me 5000 dinars”. When everything is clear the entry is saved after 5 seconds and can be undone. Say “dinars” or “centimes” to avoid the amount question. The browser sends the audio to its maker to transcribe it, so it needs the internet." },
    { q: "What if I lose the phone?", a: "Turn on One-tap backup (More → Backup) and send the copy to Drive or WhatsApp. On the new phone tap “I already have a backup” and enter the passphrase." },
    { q: "Where is my data?", a: "Only on this device (browser IndexedDB). It can be lost if site data is cleared. Download an encrypted backup regularly (More → Backup). A forgotten passphrase cannot be recovered." },
  ],
};

export function Help() {
  const { t, lang } = useApp();
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("help")}</h1>
      <div className="grid gap-2">
        {HELP[lang].map((h) => (
          <details key={h.q} className="card p-4">
            <summary className="cursor-pointer font-semibold">{h.q}</summary>
            <p className="mt-2">{h.a}</p>
          </details>
        ))}
      </div>
    </>
  );
}

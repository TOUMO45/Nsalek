"use client";
import { useApp } from "@/lib/ui/state";
import { useCloud } from "@/lib/ui/cloud";
import { useDrive } from "@/lib/ui/drive";

/** `cloud` / `drive`: shown only where accounts / the Google Drive copy exist. */
const HELP: Record<"ar" | "fr" | "en", { q: string; a: string; cloud?: boolean; drive?: boolean }[]> = {
  ar: [
    { q: "ما الفرق بين «ليك» و«عليك»؟", a: "«ليك» (مستحق لك): مال يدين لك به شخص آخر. «عليك» (مستحق عليك): مال تدين به أنت. يُعرضان دائماً منفصلين، ولا يُخصم أحدهما من الآخر إلا بمقاصة صريحة تسجلها أنت." },
    { q: "كيف أسجل ديناً بسرعة؟", a: "اضغط «إضافة»، اختر الاتجاه، اكتب الاسم والمبلغ ثم «حفظ». تاريخ الاستحقاق والوصف والمرفقات اختيارية تحت «خيارات إضافية»." },
    { q: "كيف أسجل تسديداً؟", a: "من صفحة الشخص اضغط «تسجيل تسديد». يُوزَّع المبلغ تلقائياً على الأقدم استحقاقاً، ويمكنك تعديل التوزيع يدوياً. إذا كان المبلغ أكبر من الدين، يجب أن تختار صراحةً تسجيل الفائض كتسبيق." },
    { q: "أخطأت في مبلغ. كيف أصححه؟", a: "القيود المسجلة لا تُمسح. استعمل «تصحيح المبلغ» (زيادة، تخفيض، تنازل، شطب) مع سبب، أو «إلغاء القيد» إذا لم يكن عليه تسديد، أو «عكس التسديد». كل تصحيح يبقى في السجل." },
    { q: "المبالغ بالسنتيم؟", a: "اختر «سنتيم» بجانب حقل المبلغ: يُعرض التحويل إلى الدينار ويجب تأكيده قبل الحفظ. لا نفهم «ألف» أو «مليون» كتابةً؛ اكتب الأرقام." },
    { q: "التذكير عبر واتساب أو SMS", a: "من «المستحقات» ← «قائمة التذكير»: راجع الرسالة لكل شخص ثم افتحها في تطبيقك وأرسلها بنفسك. بعد الإرسال اضغط «تم الإرسال». لا يُرسل شيء تلقائياً، ولا نكتب «وصلت»." },
    { q: "الإدخال بالصوت", a: "اضغط الميكروفون وقل مثلاً «محمد دا ألفين دينار» أو «سمير خلصني خمسة آلاف دينار». إذا كان كل شيء واضحاً يُحفظ بعد 5 ثوانٍ ويمكنك الإلغاء. قل «دينار» أو «سنتيم» حتى لا يُسأل عن المبلغ. المتصفح يرسل الصوت إلى شركته لتحويله إلى نص، لذلك يحتاج إلى الإنترنت." },
    { q: "إذا ضاع الهاتف؟", a: "فعّل «نسخة احتياطية بلمسة واحدة» في المزيد ← النسخ الاحتياطي وأرسل النسخة إلى Drive أو واتساب. على الهاتف الجديد اضغط «عندي نسخة احتياطية» واكتب كلمة المرور." },
    { q: "الحساب والنسخة السحابية", a: "من «المزيد ← الحساب» سجّل الدخول بحساب Google أو بالبريد. بعدها يُحفظ دفترك على الإنترنت وحده بعد كل تغيير، وتظهر سحابة خضراء في الأعلى. على هاتف جديد اضغط «لدي حساب» ويعود كل شيء. نسيت كلمة السر؟ يصلك رابط بالبريد ولا تضيع بياناتك. أخطأت؟ ارجع إلى نسخة سابقة. الصور لا تُرفع: خذ لها نسخة احتياطية في ملف.", cloud: true },
    { q: "نسخة في Google Drive الخاص بي", a: "من «المزيد ← النسخ الاحتياطي» اضغط «ربط Google Drive». تذهب نسخة من دفترك، مع الصور، إلى مجلد مخفي في Google Drive الخاص بك، تُحسب من مساحة Google الخاصة بك. إذن Google يدوم حوالي ساعة وتُنسخ التغييرات خلالها وحدها، ثم اضغط «انسخ الآن». على هاتف جديد اختر «استرجع من Google Drive». إذا امتلأت مساحتك أفرغ مكاناً أو اشترِ مساحة من Google.", drive: true },
    { q: "هل أستعمل هاتفين معاً؟", a: "نعم بالحساب نفسه. تصل التغييرات عند فتح التطبيق أو بعد دقائق، لا في اللحظة نفسها. إذا غيّرت الشيء نفسه على الهاتفين يسألك التطبيق أيّهما تبقي، ولا يقرر وحده في المال.", cloud: true },
    { q: "أين تُحفظ بياناتي؟", a: "على هذا الجهاز (IndexedDB في المتصفح)، وقد يحذفها المتصفح إذا مُسحت بيانات الموقع. إذا سجّلت الدخول بحساب تُحفظ نسخة على خوادم Google أيضاً، ويمكن لصاحب التطبيق تقنياً الوصول إليها. بدون حساب، خذ نسخة احتياطية مشفرة بانتظام من «المزيد ← النسخ الاحتياطي». إذا نسيت كلمة مرور ملف النسخة فلا يمكن فتحه." },
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
    { q: "Compte et copie en ligne", a: "Dans « Plus » → « Compte », connectez-vous avec Google ou par e-mail. Votre carnet est ensuite copié en ligne tout seul après chaque changement (nuage vert en haut). Sur un nouveau téléphone, touchez « J’ai déjà un compte » et tout revient. Mot de passe oublié : un lien arrive par e-mail, rien n’est perdu. Une erreur : revenez à une copie précédente. Les photos ne sont pas envoyées : gardez-les avec une sauvegarde en fichier.", cloud: true },
    { q: "Copie dans mon Google Drive", a: "Dans « Plus » → « Sauvegarde », touchez « Connecter Google Drive ». Une copie du carnet, photos comprises, va dans un dossier caché de votre Google Drive et compte dans votre espace Google. L’autorisation de Google dure environ une heure : les changements sont copiés d’eux-mêmes pendant ce temps, ensuite touchez « Copier maintenant ». Sur un nouveau téléphone, « Restaurer depuis Google Drive ». Espace plein : libérez de la place ou achetez de l’espace chez Google.", drive: true },
    { q: "Puis-je utiliser deux téléphones ?", a: "Oui, avec le même compte. Les changements arrivent à l’ouverture ou en quelques minutes, pas à l’instant même. Si la même chose a changé des deux côtés, l’application vous demande laquelle garder : elle ne décide jamais seule pour de l’argent.", cloud: true },
    { q: "Où sont mes données ?", a: "Sur cet appareil (IndexedDB du navigateur), et elles peuvent être effacées avec les données du site. Avec un compte, une copie est aussi gardée sur des serveurs de Google, et l’exploitant de l’application peut techniquement y accéder. Sans compte, faites régulièrement une sauvegarde chiffrée (« Plus » → « Sauvegarde »). La phrase secrète d’une sauvegarde, si elle est oubliée, ne peut pas être récupérée." },
    { q: "Relevé PDF", a: "Fiche de la personne → « Relevé » : choisissez la période et la langue, puis « Imprimer / PDF » et « Enregistrer au format PDF »." },
  ],
  en: [
    { q: "“Owed to me” vs “I owe”", a: "Owed to me (ليك): money someone owes you. I owe (عليك): money you owe. They are always shown separately and never offset unless you record an explicit netting." },
    { q: "Record a debt fast", a: "Tap Add, pick the direction, type a name and an amount, then Save. Due date, description and attachments are optional under More options." },
    { q: "Record a repayment", a: "On the person’s page, Record repayment. It is allocated oldest-due first; you can adjust it manually. An excess is accepted only if you explicitly keep it as an advance." },
    { q: "Fix a mistake", a: "Entries are never erased. Use Adjust (increase, decrease, waive, write off) with a reason, Void entry when there is no repayment, or Reverse repayment. Every correction stays visible." },
    { q: "Voice entry", a: "Tap the microphone and say for example “محمد دا ألفين دينار” or “Samir paid me 5000 dinars”. When everything is clear the entry is saved after 5 seconds and can be undone. Say “dinars” or “centimes” to avoid the amount question. The browser sends the audio to its maker to transcribe it, so it needs the internet." },
    { q: "What if I lose the phone?", a: "Turn on One-tap backup (More → Backup) and send the copy to Drive or WhatsApp. On the new phone tap “I already have a backup” and enter the passphrase." },
    { q: "Account and cloud copy", a: "In More → Account, sign in with Google or email. Your notebook is then copied online by itself after every change (green cloud at the top). On a new phone tap “I already have an account” and everything comes back. Forgot your password? A link comes by email and nothing is lost. Made a mistake? Go back to an older copy. Photos are not sent: keep them with a backup file.", cloud: true },
    { q: "Copy in my Google Drive", a: "In More → Backup, tap “Connect Google Drive”. A copy of your notebook, photos included, goes to a hidden folder of your own Google Drive and counts in your Google storage. Google’s permission lasts about an hour: changes are copied by themselves meanwhile, then tap “Copy now”. On a new phone, “Restore from Google Drive”. Storage full: free some space or buy more from Google.", drive: true },
    { q: "Can I use two phones?", a: "Yes, with the same account. Changes arrive when the app is opened or within minutes, not at the same instant. If the same thing changed on both, the app asks which one to keep: it never decides alone about money.", cloud: true },
    { q: "Where is my data?", a: "On this device (browser IndexedDB), and it can be lost if site data is cleared. With an account a copy is also kept on Google servers, and the operator of the app can technically access it. Without an account, make an encrypted backup regularly (More → Backup). The passphrase of a backup file, once forgotten, cannot be recovered." },
  ],
};

export function Help() {
  const { t, lang } = useApp();
  const { available } = useCloud();
  const drive = useDrive().available;
  return (
    <>
      <h1 className="text-[22px] font-bold">{t("help")}</h1>
      <div className="grid gap-2">
        {HELP[lang].filter((h) => (available || !h.cloud) && (drive || !h.drive)).map((h) => (
          <details key={h.q} className="card p-4">
            <summary className="cursor-pointer font-semibold">{h.q}</summary>
            <p className="mt-2">{h.a}</p>
          </details>
        ))}
      </div>
    </>
  );
}

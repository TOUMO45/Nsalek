// Texts of the Google Drive copy: [Arabic, French, English].
import type { Lang } from "../core/money.ts";
import { errorMessage } from "./i18n.ts";

const IDX: Record<Lang, 0 | 1 | 2> = { ar: 0, fr: 1, en: 2 };

const T = {
  title: ["نسخة في Google Drive الخاص بك", "Copie dans votre Google Drive", "Copy in your Google Drive"],
  why: [
    "احتفظ بنسخة من دفترك، مع الصور، في Google Drive الخاص بك. Nsalek وحده يستطيع فتحها، وتُحسب من مساحة Google الخاصة بك (15 جيغا مجاناً).",
    "Gardez une copie de votre carnet, photos comprises, dans votre propre Google Drive. Seul Nsalek peut l’ouvrir, et elle compte dans votre espace Google (15 Go gratuits).",
    "Keep a copy of your notebook, photos included, in your own Google Drive. Only Nsalek can open it, and it counts in your Google storage (15 GB free).",
  ],
  second: [
    "هذه نسخة ثانية، في مكان آخر. لا تعوّض حساب Nsalek الذي يحفظ بعد كل تغيير.",
    "C’est une deuxième copie, ailleurs. Elle ne remplace pas le compte Nsalek, qui copie après chaque changement.",
    "This is a second copy, somewhere else. It does not replace the Nsalek account, which copies after every change.",
  ],
  folder: [
    "سيطلب منك Google أن تسمح لـ Nsalek بمجلده المخفي. لا يرى Nsalek ملفاتك الأخرى.",
    "Google vous demandera d’autoriser Nsalek à utiliser son dossier caché. Nsalek ne voit pas vos autres fichiers.",
    "Google will ask you to let Nsalek use its own hidden folder. Nsalek cannot see your other files.",
  ],
  connect: ["ربط Google Drive", "Connecter Google Drive", "Connect Google Drive"],
  loading: ["جارٍ تحضير Google…", "Préparation de Google…", "Getting Google ready…"],
  account: ["الحساب", "Compte", "Account"],
  last: ["آخر نسخة", "Dernière copie", "Last copy"],
  never: ["لا شيء بعد", "Aucune pour l’instant", "None yet"],
  auto: ["تُنسخ التغييرات وحدها والتطبيق مفتوح، حتى", "Les changements sont copiés d’eux-mêmes, application ouverte, jusqu’à", "Changes are copied by themselves while the app is open, until"],
  tap: [
    "إذن Google يدوم حوالي ساعة. اضغط «انسخ الآن» لنسخ ما تغيّر.",
    "L’autorisation de Google dure environ une heure. Touchez « Copier maintenant » pour copier ce qui a changé.",
    "Google’s permission lasts about an hour. Tap “Copy now” to copy what changed.",
  ],
  waiting: ["تغييرات لم تُنسخ بعد إلى Drive.", "Des changements ne sont pas encore copiés dans Drive.", "Some changes are not copied to Drive yet."],
  upToDate: ["كل شيء منسوخ في Drive.", "Tout est copié dans Drive.", "Everything is copied to Drive."],
  copyNow: ["انسخ الآن", "Copier maintenant", "Copy now"],
  copying: ["جارٍ النسخ…", "Copie en cours…", "Copying…"],
  copied: ["تم النسخ في Google Drive.", "Copié dans Google Drive.", "Copied to Google Drive."],
  nothing: ["لا شيء للنسخ: الدفتر فارغ.", "Rien à copier : le carnet est vide.", "Nothing to copy: the notebook is empty."],
  storage: ["مساحة Google المستعملة", "Espace Google utilisé", "Google storage used"],
  of: ["من", "sur", "of"],
  showCopies: ["النسخ الموجودة في Drive", "Copies dans Drive", "Copies in Drive"],
  open: ["افتح النسخ", "Voir les copies", "Show the copies"],
  none: ["لا توجد نسخة في هذا الـ Drive بعد.", "Aucune copie dans ce Drive pour l’instant.", "No copy in this Drive yet."],
  thisPhone: ["هذا الهاتف", "ce téléphone", "this phone"],
  otherPhone: ["هاتف آخر", "un autre téléphone", "another phone"],
  people: ["الأشخاص", "Personnes", "People"],
  entries: ["القيود", "Écritures", "Entries"],
  photos: ["الصور", "Photos", "Photos"],
  putBack: ["استرجع هذه النسخة", "Remettre cette copie", "Put this copy back"],
  opening: ["جارٍ الفتح…", "Ouverture…", "Opening…"],
  back: ["رجوع", "Retour", "Back"],
  stop: ["أوقف النسخ في Google Drive", "Arrêter la copie dans Google Drive", "Stop copying to Google Drive"],
  stopAsk: [
    "لن تُنسخ التغييرات بعد الآن في Google Drive من هذا الهاتف. النسخ الموجودة تبقى هناك.",
    "Les changements ne seront plus copiés dans Google Drive depuis ce téléphone. Les copies déjà faites y restent.",
    "Changes will no longer be copied to Google Drive from this phone. The copies already made stay there.",
  ],
  stopInfo: [
    "لحذف النسخ: Google Drive ← الإعدادات ← إدارة التطبيقات ← Nsalek ← حذف البيانات المخفية.",
    "Pour effacer les copies : Google Drive → Paramètres → Gérer les applications → Nsalek → Supprimer les données d’application cachées.",
    "To delete the copies: Google Drive → Settings → Manage apps → Nsalek → Delete hidden app data.",
  ],
  fromDrive: ["استرجع من Google Drive", "Restaurer depuis Google Drive", "Restore from Google Drive"],
  fromDriveHelp: [
    "اختر حساب Google الذي كانت تُنسخ فيه نسخك، ثم اختر نسخة.",
    "Choisissez le compte Google où vos copies étaient faites, puis une copie.",
    "Choose the Google account your copies went to, then choose a copy.",
  ],
  openDrive: ["افتح Google Drive الخاص بي", "Ouvrir mon Google Drive", "Open my Google Drive"],
  // What went wrong
  drive_auth: ["انتهى إذن Google. اضغط على الزر مرة أخرى.", "L’autorisation de Google a pris fin. Touchez le bouton encore une fois.", "Google’s permission ended. Tap the button again."],
  drive_full: [
    "مساحة Google الخاصة بك ممتلئة. أفرغ مكاناً في Google Drive أو Gmail أو الصور، أو اشترِ مساحة من Google، ثم اضغط «انسخ الآن». بياناتك على الهاتف.",
    "Votre espace Google est plein. Libérez de la place dans Google Drive, Gmail ou Photos, ou achetez de l’espace chez Google, puis touchez « Copier maintenant ». Vos données sont sur le téléphone.",
    "Your Google storage is full. Free some space in Google Drive, Gmail or Photos, or buy more storage from Google, then tap “Copy now”. Your data is on this phone.",
  ],
  drive_offline: ["لا اتصال بالإنترنت، أو الاتصال ضعيف. بياناتك على الهاتف.", "Pas de connexion internet, ou trop faible. Vos données sont sur le téléphone.", "No internet connection, or it is too weak. Your data is on this phone."],
  drive_busy: ["Google مشغول الآن. جرّب بعد قليل.", "Google est occupé. Réessayez dans un moment.", "Google is busy right now. Try again in a moment."],
  drive_denied: ["رفض Google الطلب. اضغط «انسخ الآن» واقبل من جديد.", "Google a refusé. Touchez « Copier maintenant » et acceptez de nouveau.", "Google refused. Tap “Copy now” and allow it again."],
  drive_off: ["Google Drive غير مفعّل لـ Nsalek بعد.", "Google Drive n’est pas encore activé pour Nsalek.", "Google Drive is not switched on for Nsalek yet."],
  drive_gone: ["هذه النسخة لم تعد في Drive الخاص بك.", "Cette copie n’est plus dans votre Drive.", "This copy is no longer in your Drive."],
  drive_damaged: ["هذه النسخة تالفة. لم يتغيّر شيء على هاتفك. اختر نسخة أقدم.", "Cette copie est abîmée. Rien n’a changé sur votre téléphone. Choisissez une copie plus ancienne.", "This copy is damaged. Nothing changed on your phone. Choose an older copy."],
  drive_invalid: [
    "في الدفتر قيد غير متناسق، فلم تُرسل نسخته. بياناتك على الهاتف: خذ نسخة احتياطية في ملف.",
    "Le carnet contient une écriture incohérente : la copie n’a pas été envoyée. Vos données sont sur le téléphone ; faites une sauvegarde en fichier.",
    "The notebook has an inconsistent entry, so its copy was not sent. Your data is on this phone; make a backup file.",
  ],
  drive_closed: ["أُغلقت نافذة Google. لم يتغيّر شيء.", "La fenêtre de Google a été fermée. Rien n’a changé.", "Google’s window was closed. Nothing changed."],
  drive_popup: ["منع المتصفح نافذة Google. اسمح بالنوافذ المنبثقة لـ Nsalek ثم أعد المحاولة.", "Le navigateur a bloqué la fenêtre de Google. Autorisez les fenêtres pour Nsalek, puis réessayez.", "The browser blocked Google’s window. Allow pop-ups for Nsalek, then try again."],
  drive_scope: [
    "لم يُعطِ Google مجلده لـ Nsalek: ضع علامة على خانة Google Drive ثم أعد المحاولة.",
    "Google n’a pas donné son dossier à Nsalek : cochez la case Google Drive, puis réessayez.",
    "Google did not give Nsalek its folder: tick the Google Drive box, then try again.",
  ],
  drive_failed: ["تعذّر النسخ في Google Drive. بياناتك على الهاتف.", "Copie dans Google Drive impossible. Vos données sont sur le téléphone.", "Could not copy to Google Drive. Your data is on this phone."],
} satisfies Record<string, [string, string, string]>;

export type DKey = keyof typeof T;

export function driveText(lang: Lang, k: DKey): string {
  return T[k][IDX[lang]];
}

export function driveError(lang: Lang, e: unknown): string {
  const code = typeof e === "string" ? e : String((e as { code?: string })?.code ?? "");
  return code in T ? T[code as DKey][IDX[lang]] : errorMessage(lang, typeof e === "string" ? { code } : e);
}

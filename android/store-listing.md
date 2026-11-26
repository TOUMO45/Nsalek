# Google Play listing texts (draft, Arabic and French)

Not published. Written 2026-11-26 from `docs/capabilities.md`, `docs/help-ar.md` and `docs/help-fr.md`.
Every line describes something the current build does; nothing here was tried inside the Android app.

Play limits: app name 30 characters, short description 80, full description 4,000.
Character counts below were measured with JavaScript `[...text].length`.

Rules for any edit:

- No superlatives or comparisons ("best", "most secure", "#1", "the safest"), no "100% free forever", no prices.
- No feature that does not exist: the app does **not** send reminders by itself, does **not** connect to a bank
  or move money, does **not** copy photos to the account copy, and has **no** closed-app reminders.
- Keep the account sentence honest: the account copy is **not** end-to-end encrypted.

## App name (both languages)

```
Nsalek — نسالك
```

14 characters.

## Arabic (ar)

### Short description (66 characters)

```
دفتر ديون للمحل: من يدين لك ولمن تدين. حساب اختياري، بدون إعلانات.
```

### Full description (1,660 characters)

```
نسالك دفتر ديون بسيط للمحلات وللاستعمال الشخصي: تسجّل من يدين لك («ليك») ولمن تدين أنت («عليك»)، وتتابع التسديدات والمواعيد.

ما يفعله التطبيق
• تسجيل دين بسرعة: الاتجاه، الاسم والمبلغ. تاريخ الاستحقاق والوصف والأقساط والمرفقات اختيارية.
• تسجيل التسديدات: يُوزَّع المبلغ على الديون الأقدم، ويمكنك تعديل التوزيع بيدك. الفائض لا يُقبل إلا إذا سجّلته كتسبيق.
• القيود لا تُمسح: التصحيح يكون بقيد تصحيح أو إلغاء مع ذكر السبب، ويبقى كل شيء ظاهراً في السجل.
• المستحقات: ما يجب متابعته اليوم، المتأخر، هذا الأسبوع، والوعود بالدفع.
• التذكير: يحضّر التطبيق الرسالة، تراجعها ثم ترسلها أنت بنفسك عبر واتساب أو SMS أو البريد. لا يُرسل التطبيق أي شيء تلقائياً.
• كشف حساب لكل شخص، للطباعة أو الحفظ PDF، بالعربية أو الفرنسية أو الإنجليزية.
• خيار السنتيم: تكتب المبلغ بالسنتيم ويُعرض ما يعادله بالدينار لتؤكده.
• الإدخال بالصوت (اختياري، بعد موافقتك).
• إخفاء المبالغ وقفل PIN (شاشة خصوصية، وليس تشفيراً).
• نسخة احتياطية في ملف يمكن تشفيره بكلمة مرور، وتصدير CSV.
• يعمل بدون إنترنت: التسجيل والتسديد وكشف الحساب تتم على الهاتف نفسه.
• العربية والفرنسية والإنجليزية.

بياناتك
• بدون حساب: الدفتر يبقى في هاتفك فقط.
• حساب اختياري (Google أو بريد إلكتروني): تُحفظ نسخة من الدفتر على خوادم Google بعد كل تغيير، وتعود إليك على هاتف جديد. هذه النسخة ليست مشفرة من طرف إلى طرف: صاحب التطبيق يستطيع تقنياً قراءتها. الصور لا تُرفع فيها.
• نسخة اختيارية في Google Drive الخاص بك، مع الصور، في مجلد مخفي لا يرى فيه Nsalek إلا نسخه.
• لا إعلانات، لا أدوات تتبع، ولا بيع للبيانات.

مهم
• نسالك دفتر فقط: لا يتصل بالبنك، ولا يحوّل المال، ولا يُقرض.
• يعمل التطبيق داخل متصفح هاتفك (Chrome عادةً). إذا مُسحت بيانات هذا الموقع بدون نسخة احتياطية، يضيع الدفتر. احتفظ بنسخة خارج الهاتف.
```

## French (fr-FR)

### Short description (80 characters: exactly the limit)

```
Carnet de dettes : qui vous doit, à qui vous devez. Compte facultatif, sans pub.
```

### Full description (2,302 characters)

```
Nsalek est un carnet de dettes simple, pour les commerces et pour un usage personnel : notez qui vous doit (« On me doit ») et à qui vous devez (« Je dois »), et suivez les remboursements et les échéances.

Ce que fait l’application
• Enregistrer une dette rapidement : le sens, le nom, le montant. Échéance, description, échéancier et pièces jointes sont facultatifs.
• Enregistrer un remboursement : le montant va aux dettes les plus anciennes, ajustable à la main. Un excédent n’est accepté que si vous l’enregistrez comme avance.
• Rien n’est effacé : on corrige par un ajustement ou une annulation, avec un motif, et tout reste visible dans l’historique.
• Échéances : à faire aujourd’hui, en retard, cette semaine, promesses de paiement.
• Relances : l’application prépare le message, vous le relisez et l’envoyez vous-même par WhatsApp, SMS ou e-mail. Rien n’est envoyé automatiquement.
• Relevé par personne, à imprimer ou à enregistrer en PDF, en arabe, en français ou en anglais.
• Mode centimes : vous tapez en centimes, l’équivalent en DA s’affiche et vous le confirmez.
• Saisie vocale (facultative, après votre accord).
• Masquer les montants et code PIN (écran de confidentialité, pas un chiffrement).
• Sauvegarde dans un fichier, chiffrable par une phrase secrète, et export CSV.
• Fonctionne sans Internet : enregistrements, remboursements et relevés se font sur le téléphone.
• Arabe, français et anglais.

Vos données
• Sans compte : le carnet reste uniquement sur votre téléphone.
• Compte facultatif (Google ou e-mail) : une copie du carnet est gardée sur les serveurs de Google après chaque changement, et revient sur un nouveau téléphone. Cette copie n’est pas chiffrée de bout en bout : l’exploitant de l’application peut techniquement la lire. Les photos n’y sont pas copiées.
• Copie facultative dans votre propre Google Drive, photos comprises, dans un dossier caché où Nsalek ne voit que ses copies.
• Pas de publicité, pas de pistage, aucune vente de données.

À savoir
• Nsalek est un carnet : il ne se connecte à aucune banque, ne transfère pas d’argent et ne prête pas.
• L’application fonctionne dans le navigateur de votre téléphone (Chrome en général). Si les données de ce site sont effacées sans sauvegarde, le carnet est perdu. Gardez une copie hors du téléphone.
```

## Before pasting these into Play Console

- **"Works without the internet"**: recording offline works once the app is open, but reopening the app with
  no network is **not verified** (`docs/capabilities.md`, Offline). Try it on the phone (airplane mode, close,
  reopen). If it fails, remove that line in both languages.
- **PDF statement**: printing was verified with Edge on a computer, not inside the Android app. Try
  "Print / PDF" on the phone; if it does not work there, change "للطباعة أو الحفظ PDF" / "à imprimer ou à
  enregistrer en PDF" accordingly.
- **Account and Google Drive**: only tried on emulators and with a fake Drive, and not switched on for the live
  site. Do not publish the account and Drive lines, nor "حساب اختياري" / "Compte facultatif" in the short
  descriptions, until they work on the live site and in the Android app (`docs/cloud-activation.md` step 7).
- **Voice entry** depends on the phone's speech service; check it once in the Android app.
- Screenshots must be taken from the real app on a phone, with the demo notebook (invented names), never with a
  real customer's data.

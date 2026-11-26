# Android app (Trusted Web Activity): release guide for the owner

Status on 2026-11-26: **prepared, not built, not tried on a phone, not published.** No key, keystore, Play
account or Google Cloud setting was created. Every step below is the owner's to run, and each one that touches
Google Play, Firebase or the live site needs the owner's own yes (decision D21).

Prepared files:

| File | What it is |
|---|---|
| `android/twa-manifest.json` | Bubblewrap's description of the Android app (package, name, colours, icon, signing key path) |
| `android/assetlinks.template.json` | The Digital Asset Links file to fill in and publish at `/.well-known/assetlinks.json` |
| `android/store-listing.md` | Play Store texts in Arabic and French, with their character counts |
| `public/privacy.html` | Privacy policy, **draft for a lawyer's review**, with placeholders to fill |

## 1. What a TWA is

- The Android app is a thin shell. It opens **the same web app**, `https://nsalek-app.web.app`, full screen,
  in the phone's browser engine (Chrome on most phones), without the address bar.
- **Updates come from the website.** Publishing the website updates the app; the new version shows once the
  service worker has picked it up (usually at the next opening). A new upload to Play is needed only when the
  shell changes: name, icon, colours, package, version, or Play's yearly target API level (see 5.4).
- **The notebook lives in the browser's storage for `nsalek-app.web.app`, not in the shell.** In Chrome it is
  the same storage as the website opened in Chrome on that phone, so both show the same notebook. Someone who
  used the website in another browser (Samsung Internet, Firefox…) will not see that notebook in the app: they
  need a backup file, the account, or the Drive copy to move it. (This is how TWAs work; not yet seen on a
  phone with Nsalek.)
- The shell proves it belongs to the site through `/.well-known/assetlinks.json` (section 6). If that check
  fails, the app still opens but **shows an address bar at the top**: that is the sign to look for.
- `fallbackType: "customtabs"`: on a phone without a browser that supports TWAs, the site opens in a Custom
  Tab (with an address bar).

## 2. Choices made in `android/twa-manifest.json`

- **`packageId: "app.nsalek.twa"` is a proposal.** The package name is permanent on Google Play: it can never
  be changed after the first upload. By convention it is a reversed domain you control; `nsalek.app` is not
  known to be yours, so check it or pick another (for example one based on a domain the owner owns) **before
  the first build**. If you change it, change it in `twa-manifest.json` and in `assetlinks.json` too.
- The brand "Nsalek / نسالك" is not trademark-cleared (decision D20). Check before a public store listing.
- Field names were checked against Bubblewrap's source (`packages/core/src/lib/TwaManifest.ts`, read
  2026-11-26). The version name is read from the key **`appVersion`**; Bubblewrap also writes
  `appVersionName` when it saves the file, so both are present with `0.1.0`. `appVersionCode` is `1`.
- Colours: theme and navigation `#0e6b50`, background `#eff6f2`. Dark-mode bars are set to the same green
  (Bubblewrap's default would be black).
- Icon and maskable icon both use `https://nsalek-app.web.app/icon-512.png` (the web manifest marks it
  "any maskable"). After the first build, look at the launcher icon: if the edges are cut, a separate maskable
  icon with more margin is needed. Note (D38) that the 192/512 px icons keep the older, darker green.
- `orientation: "portrait"`, `display: "standalone"`, `enableNotifications: true`, `minSdkVersion: 21`.
- Signing key: `./nsalek-upload.keystore`, alias `nsalek` (section 4). The file does not exist yet.

## 3. Prerequisites

1. **Google Play developer account.** A one-time registration fee, paid by the owner during sign-up (Play
   Console shows the current amount), plus Google's identity verification. This is the owner's own purchase
   and account; nobody else should create it.
2. **Testing rule for new personal accounts.** For personal developer accounts created after 13 November
   2023, Google requires a **closed test with at least 12 testers who stay opted in for 14 days in a row**
   before you can apply for production (Play Console Help, answer 14151465, read 2026-11-26). Plan for it.
3. **A computer** with Node.js, plus **JDK 17** and the **Android SDK**. Bubblewrap offers to download both on
   first use and keeps their paths in `~/.bubblewrap/config.json`. JDK 17 exactly: lower cannot compile the
   project, higher does not work with the Android command-line tools. The SDK path must not contain spaces.
   `npx @bubblewrap/cli doctor` checks both.
4. **The live site** must already serve the web manifest, the icons, the service worker and the privacy page.
5. **A working folder outside this repository**, for example `C:\nsalek-android`. The generated Android project
   and, above all, the keystore must never enter git.
   **Never run Bubblewrap in the repository root.** `bubblewrap update` (and `build` when it offers to update)
   first deletes `app/`, `gradle/`, `build.gradle`, `settings.gradle`, `gradle.properties`, `gradlew`,
   `gradlew.bat` and `store_icon.png` in the current folder, then writes new ones (Bubblewrap's
   `TwaGenerator.removeTwaProject`, read 2026-11-26). In this repository `app/` is the web app itself.

## 4. The signing key: create it once, back it up twice

Since August 2021, new apps on Google Play are published as App Bundles with **Play App Signing**: Google keeps
the key that signs what users install (the *app signing key*), and you keep only an **upload key** that proves
the uploads come from you. Accept Play App Signing with a key generated by Google (the default when you create
the app). Then, if the upload key is lost or leaks, you can ask Google for an **upload key reset** in Play
Console and keep updating the app. Without Play App Signing, losing the key would mean never updating the app
again.

Create the upload key (JDK 17's `keytool`; Bubblewrap's JDK is under `~/.bubblewrap/jdk`):

```
cd C:\nsalek-android
keytool -genkeypair -v -keystore nsalek-upload.keystore -alias nsalek -keyalg RSA -keysize 2048 -validity 10000
```

It asks for a keystore password, a key password and a name. Use two long passwords from a password manager.

Back it up **before** the first upload:

- the file `nsalek-upload.keystore` **and** both passwords, in two separate places you control (for example a
  password manager's file attachment and an encrypted USB key kept elsewhere);
- never commit it, never send it by WhatsApp or e-mail, never put it in the web project folder (`public/` is
  published to the internet as it is);
- write down the alias (`nsalek`) and the SHA-256 fingerprint (section 6) next to it.

## 5. Build

### 5.1 From the prepared file (recommended)

```
cd C:\nsalek-android
copy B:\Desktop\Nsalek\android\twa-manifest.json .
npx @bubblewrap/cli doctor
npx @bubblewrap/cli update --skipVersionUpgrade
npx @bubblewrap/cli build
```

- `update` reads `twa-manifest.json` in the current folder, deletes any Android project files there and
  generates the project again (it also downloads the icons from the live site). That is why it must run in
  `C:\nsalek-android`, never in `B:\Desktop\Nsalek`. `--skipVersionUpgrade` keeps `0.1.0` / `1` for the first
  build.
- `build` asks for the two passwords (or reads `BUBBLEWRAP_KEYSTORE_PASSWORD` and `BUBBLEWRAP_KEY_PASSWORD`
  from the environment; do not write them in a script) and produces:
  - `app-release-bundle.aab`: the file to upload to Google Play;
  - `app-release-signed.apk`: signed with your upload key, to install directly on your own phone.

### 5.2 Or start from the website

```
cd C:\nsalek-android
npx @bubblewrap/cli init --manifest https://nsalek-app.web.app/manifest.webmanifest
```

It asks the same questions; answer with the values of `android/twa-manifest.json` (package, name, launcher
name, colours, orientation, notifications, key path `./nsalek-upload.keystore`, alias `nsalek`). Then
`npx @bubblewrap/cli build`.

### 5.3 Later versions

Each upload to Play needs a higher version code. `npx @bubblewrap/cli update --appVersionName=0.1.1` raises
`appVersionCode` and sets the new name; then `build` again. Copy the updated `twa-manifest.json` back into
`android/` so the repository keeps the current values.

### 5.4 Target API level

From 31 August 2026, new apps and updates on Google Play must target **Android 16 (API level 36)** or higher
(developer.android.com, target-sdk page, read 2026-11-26). Bubblewrap's project template on its main branch
uses `targetSdkVersion 36`. After the build, open `app/build.gradle` and check that `targetSdkVersion` is 36
or more; if not, update Bubblewrap (`npx @bubblewrap/cli@latest …`). This requirement rises every year, so
plan one shell rebuild a year even if nothing else changes.

## 6. Digital Asset Links (`assetlinks.json`)

The file must list the SHA-256 fingerprints of **both** certificates:

1. **Play App Signing key**: what Play-installed copies are signed with. Play Console → your app → App
   integrity → App signing. That page also shows a ready-made Digital Asset Links snippet.
2. **Upload key**: what your locally installed `app-release-signed.apk` is signed with:
   `keytool -list -v -keystore nsalek-upload.keystore -alias nsalek` → the line `SHA256:`.

Fill `android/assetlinks.template.json` (package name and the two fingerprints, format `AA:BB:…`, 32 pairs)
and save it as **`public/.well-known/assetlinks.json`** in this repository. Or let Bubblewrap write it:

```
npx @bubblewrap/cli fingerprint add <SHA-256 of the Play App Signing key> --name="Play App Signing"
npx @bubblewrap/cli fingerprint add <SHA-256 of the upload key> --name="upload key"
npx @bubblewrap/cli fingerprint generateAssetLinks --output=assetlinks.json
```

It must be served at exactly `https://nsalek-app.web.app/.well-known/assetlinks.json`, over HTTPS, with status
200, no redirect, and `Content-Type: application/json`.

**Does the build carry it?** `npm run build` copies `public/` into `out/` with Next's `recursiveCopy`, which
reads dot-folders too (read in Next 16.3.4's `dist/export/index.js`; not run). After the build, check that
`out/.well-known/assetlinks.json` exists.

**Does Firebase Hosting deploy it?** `firebase.json` has `"**/.*"` in `hosting.ignore`. With the Firebase CLI
installed on this computer (firebase-tools 15.22.0), its own file-listing function was run locally on a test
folder (nothing deployed): the current rule ignores only files whose **own** name starts with a dot
(`.DS_Store`), so `.well-known/assetlinks.json` **is** kept, but files inside other dot-folders (`.git/config`)
are kept too. Older CLI versions ignored whole dot-folders. To make the intent explicit on any version, change
this line in `firebase.json`:

```json
"ignore": ["firebase.json", "**/.*", "sample-statement*", "sample-statement/**"],
```

to:

```json
"ignore": ["firebase.json", "**/.!(well-known)", "**/.!(well-known)/**", "sample-statement*", "sample-statement/**"],
```

With firebase-tools 15.22.0 this keeps `.well-known/assetlinks.json` and drops `.DS_Store`, `sub/.hidden` and
`.git/config` (same local test). This change was **not** made; it is the owner's.

After deploying (owner's step), check from any computer:

```
curl -i https://nsalek-app.web.app/.well-known/assetlinks.json
```

and Google's own reader:
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://nsalek-app.web.app&relation=delegate_permission/common.handle_all_urls`

Publish `assetlinks.json` **before** testers install the app.

## 7. Test on a real phone

1. **Your own phone first.** Enable USB debugging, connect it, then `npx @bubblewrap/cli install` (installs
   `app-release-signed.apk`). The upload key's fingerprint must be in `assetlinks.json`, or the address bar
   shows.
2. **Internal testing track.** Play Console → create the app → Test and release → Internal testing → upload
   `app-release-bundle.aab` → add testers by e-mail → open the opt-in link on the phone and install from Play.
   This copy is signed with Google's key: the Play App Signing fingerprint must be in `assetlinks.json`.
3. **Closed test** for the 12-testers / 14-days rule (section 3), then apply for production.

Checklist on the phone (none of this has been done yet):

- [ ] No address bar at the top (asset links work), status and navigation bars green.
- [ ] Arabic right to left; switching to French and English.
- [ ] Add a debt, close the app, reopen it: the debt is there.
- [ ] Airplane mode, close, reopen: the app opens offline (**not verified anywhere yet**).
- [ ] Same notebook as the website in Chrome on the same phone.
- [ ] Notifications: the permission prompt (Android 13+), then the daily notice when opening the app.
- [ ] Share a reminder to WhatsApp, SMS and e-mail.
- [ ] Statement "Print / PDF".
- [ ] Voice entry: microphone permission and recognition.
- [ ] Attach a photo (camera and gallery).
- [ ] Import people from contacts (picker and `.vcf`), once that work is committed.
- [ ] Account: sign-up by e-mail, Google sign-in, reset e-mail, delete account (only after
      `docs/cloud-activation.md` is done on the live project).
- [ ] Google Drive: connect, copy, restore on a second phone.
- [ ] Uninstall the app: note whether the notebook is still in Chrome, and write it in the help page.

## 8. Store listing

- Texts: `android/store-listing.md` (Arabic and French; name 30, short 80, full 4,000 characters; all within).
  Read its "Before pasting" list: some lines depend on phone tests.
- Graphics to make: app icon 512 × 512 PNG, feature graphic 1024 × 500, and at least two phone screenshots
  taken in the real app with the demo notebook. None exist yet.
- Honesty rules: no "best", "most secure" or "#1"; no feature that does not exist (no automatic sending, no
  bank link, no photos in the account copy, no reminders while the app is closed).
- Category: the owner's choice; "Business" fits a shop's notebook. Contact e-mail (public) and privacy policy
  URL are required.

## 9. App content (Play Console → Policy → App content)

| Item | Answer |
|---|---|
| Privacy policy | `https://nsalek-app.web.app/privacy` (Firebase `cleanUrls` redirects `/privacy.html` there). Only after the lawyer's review and with every `[… — to fill]` replaced |
| Ads | No ads |
| App access | All functionality works without an account; the account is optional and reviewers can create their own. If Play asks for credentials, create a test account yourself and give it there |
| Target audience | 18 and over only. Not designed for children |
| Content rating | Fill the questionnaire; category "All other app types". Honest answers: no violence, sexual content, profanity, drugs or gambling; users cannot interact with each other inside the app (sharing opens WhatsApp/SMS/e-mail outside it); no location sharing; no digital purchases. The rating is whatever the questionnaire gives |
| News, health, government | No |
| Financial features (if Play asks) | Nsalek offers no loans, payments, banking, money transfer or crypto: it records debts the user writes down. Pick the option that says so; read Play's definitions first, this guide could not check that form |
| Account deletion URL | `https://nsalek-app.web.app/privacy#fr-delete` (or `#ar-delete`, `#en-delete`): the deletion section says how to delete in the app, from any browser, or by e-mail, without reinstalling the app |
| Data safety | Section 10 |

## 10. Data safety form (must match `public/privacy.html`)

Google's definitions (Play Console Help, answer 10787469, read 2026-11-26): data is **collected** when it leaves
the phone, including through a web view the app controls; transfers to a **service provider** working for you
(here Google Firebase), and transfers the user starts (sharing to WhatsApp), are not **sharing**. Data a user
puts in **their own** Google Drive, which the developer never receives, need not be declared.

General questions:

| Question | Answer |
|---|---|
| Does the app collect or share any of the required user data types? | Yes (only with the optional account, and voice entry) |
| Is all user data encrypted in transit? | Yes (HTTPS only) |
| Account creation | Yes: e-mail and password, and Google sign-in (OAuth) |
| Delete account URL | The `#…-delete` link of section 9 |
| Can users ask to delete some data without deleting the account? | Answer Yes only if you will handle such requests by e-mail; the app deletes the cloud copy only with the whole account |
| Data shared with third parties | None |
| Independent security review | No |

Data types (all **collected, not shared, optional**, purposes **App functionality** and, where noted, **Account
management**; none used for analytics, ads or personalisation; not processed ephemerally, because copies are
kept):

| Play data type | Why | Purpose |
|---|---|---|
| Personal info → Email address | account sign-in | Account management, App functionality |
| Personal info → User IDs | account identifier | Account management |
| Personal info → Name | names in the notebook; Google's profile name kept by Firebase | App functionality, Account management |
| Personal info → Phone number | phone numbers in the notebook | App functionality |
| Financial info → Other financial info | amounts owed and paid | App functionality |
| Financial info → Purchase history | invoice lines in a debt (items bought on credit) | App functionality |
| App activity → Other user-generated content | notes and descriptions | App functionality |

Judgement calls to settle before submitting:

- **Voice entry**: the audio is sent by the browser (Chrome) to Google's speech service, not to the operator.
  Google's help does not address TWAs. The cautious answer is to declare Audio → Voice or sound recordings,
  collected, optional, App functionality.
- **Photos**: go only to the account owner's own Google Drive (never to the operator) and are not in the
  account copy: per Google's help, not declared. If a reviewer disagrees, declare Photos, optional, App
  functionality.
- **Contacts** (import being added, see section 11): read on the phone, and only the ticked ones become
  people in the notebook, already declared above as names and phone numbers. The cautious answer is to also
  declare Contacts, collected, optional, App functionality, because with an account they reach the cloud copy.
- **Balance link** (being added, `lib/core/balanceLink.ts`): the figures travel inside the link after `#`,
  which browsers do not send to the server; it is shared by the user (WhatsApp…), so it is not collection.
- **IP addresses** in Google's hosting and sign-in logs are kept by Google as service provider for security;
  they are not one of Play's data types unless used for location, which Nsalek does not do.

Not collected: location, messages, calendar, health, web browsing, files and docs, device IDs, crash
logs, diagnostics.

## 11. What Nsalek cannot do as a TWA

- **It is Chrome inside.** Storage, permissions, the share sheet, printing, the microphone and the camera are
  Chrome's. Clearing Chrome's data for the site deletes the notebook, exactly as on the website.
- **Notifications** follow Chrome on Android: the shell lets the site's notifications appear as the app's, and
  Android 13+ asks for permission. Nsalek still shows its notice only when the app is opened; there are no
  reminders while it is closed, and no server sends any.
- **Contacts picker**: being added in the working tree on 2026-11-26 (`app/ui/Contacts.tsx`,
  `lib/core/contacts.ts`, not committed): the browser's contact picker where it exists, otherwise a `.vcf`
  file. In the Android app it depends on Chrome on Android's Contact Picker support, not on the shell; the
  `.vcf` route works through Chrome's file chooser. Try both on the phone.
- **Nothing runs while the app is closed**: no background sync of the account copy or the Drive copy.
- **Google sign-in and the Google Drive window** open Google's pages from inside the app; this has not been
  tried in a TWA (checklist, section 7).
- No access to SMS, the phone's contacts or files beyond what Chrome offers the website; no automatic
  WhatsApp sending.
- Google Play's policies (including minimum functionality) apply to the app like to any other; the website
  must stay up, because the app is the website.

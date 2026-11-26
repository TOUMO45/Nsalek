# Switching accounts on

Nothing below is done yet. Each step changes the live project `nsalek-app` and needs the owner's yes.
Every command names the project: the Firebase CLI on this computer also knows the clinic's.

Before: a legal check (law 18-07 amended by 25-11, ANPDP declaration, data kept outside Algeria), and a
contact address for the privacy text.

1. **Register the web app** and note its public configuration.
   `firebase apps:create WEB "Nsalek web" --project nsalek-app`, then
   `firebase apps:sdkconfig WEB --project nsalek-app`.
2. **Sign-in methods.** Console → Authentication → Get started → enable *Email/Password* and *Google*
   (support e-mail: choose it, it is shown to users). Settings → turn on *email enumeration protection*;
   password policy: at least 8 characters. Templates → Arabic or French sender name. Authorized domains:
   `nsalek-app.web.app` and `nsalek-app.firebaseapp.com` (present by default); remove `localhost` if unused.
3. **Database.** `firebase firestore:databases:create "(default)" --location eur3 --project nsalek-app`.
   **The region cannot be changed afterwards.** `eur3` (Europe, several data centres) is the nearest;
   free quota is the same. Turn on *delete protection*.
4. **Rules.** `firebase deploy --only firestore:rules --project nsalek-app`. Before any build with
   accounts is published, never after.
5. **Build.** Put the configuration of step 1 in `.env.production` (public values, see `.env.example`),
   `npm run check`, `npm run test:cloud`, then `node scripts/check-release.mjs`.
6. **Publish.** `firebase deploy --only hosting --project nsalek-app` (the check runs again by itself).
7. **Verify on the live address** with a throwaway account: sign-up, a debt, a second browser, reset
   e-mail, Google sign-in in Chrome, Safari and the installed app, then delete the account and look in
   the console that nothing is left.
8. **Watch.** Console → Usage, weekly at first. The free plan stops, it does not bill: with the Spark
   plan there is no card on file.

## Copy in the person's own Google Drive

Also in the Google Cloud project `nsalek-app` (console.cloud.google.com, the project picker shows its id):

1. **APIs & Services → Library → Google Drive API → Enable.**
2. **OAuth consent screen** (Google Auth Platform): app name Nsalek, support e-mail, logo optional, home page
   and **privacy policy** links on `nsalek-app.web.app`, authorized domain `nsalek-app.web.app`.
   **Data access → Add scope** `.../auth/drive.appdata` only (non-sensitive: basic check, no security
   assessment). **Audience → Publish app** (in "Testing" only the listed test users can connect).
3. **Clients → Create client → Web application**: authorized JavaScript origins
   `https://nsalek-app.web.app` and `https://nsalek-app.firebaseapp.com`; no redirect URI.
4. Its client id goes in `.env.production` as `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (public). Build, check and
   publish as above. `firebase.json` already lets Google's window and the Drive API through.
5. **Verify on the live address**: connect, a copy, "Copy now" after an hour, a second browser that puts
   the copy back, a copy above 4 MB (photos), and "Manage apps" in Google Drive to delete the hidden data.

**Going back:** publish the previous version (Hosting → release history → roll back). Phones keep their
notebooks; cloud copies stay until the accounts are deleted. Never delete the database to "go back".

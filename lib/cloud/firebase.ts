// Firebase: signing in, and the cloud copy in Firestore. This file is loaded only when a person
// uses an account. Nothing here decides anything about the data (see sync.ts).
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  inMemoryPersistence,
  browserPopupRedirectResolver,
  linkWithCredential,
  linkWithPopup,
  onIdTokenChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  unlink,
  updatePassword,
  type Auth,
  type User,
} from "firebase/auth";
import {
  Bytes,
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  setLogLevel,
  writeBatch,
  type Firestore,
  type Timestamp,
} from "firebase/firestore/lite";
import { cloudError } from "./errors.ts";
import { CloudError, PART_BYTES, type CloudPort, type Head, type Save, type Version } from "./port.ts";

export type CloudConfig = { apiKey: string; authDomain: string; projectId: string; appId: string; emulator?: { host: string; auth: number; firestore: number } };

export type Account = { uid: string; email: string; verified: boolean; google: boolean; googleEmail: string; password: boolean };

const TIMEOUT = 90_000;

// The SDK prints failed requests with their contents; nothing about a notebook belongs in a console.
setLogLevel("silent");

async function safe<T>(job: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      job,
      new Promise<never>((_, no) => {
        timer = setTimeout(() => no(new CloudError("cloud_offline")), TIMEOUT);
      }),
    ]);
  } catch (e) {
    throw cloudError(e);
  } finally {
    clearTimeout(timer);
  }
}

/** The rules refuse what comes within two seconds of the last save: tried once more after that. */
async function inPace(job: () => Promise<void>, otherwise?: () => Promise<void>): Promise<void> {
  try {
    await job();
  } catch (e) {
    if ((e as CloudError).code !== "cloud_denied") throw e;
    await otherwise?.();
    await new Promise((r) => setTimeout(r, 2500));
    await job();
  }
}

const accountOf = (u: User): Account => ({
  uid: u.uid,
  email: u.email ?? "",
  verified: u.emailVerified,
  google: u.providerData.some((p) => p.providerId === "google.com"),
  googleEmail: u.providerData.find((p) => p.providerId === "google.com")?.email ?? "",
  password: u.providerData.some((p) => p.providerId === "password"),
});

export class FirebaseCloud {
  private app: FirebaseApp;
  private auth: Auth;
  private db: Firestore;

  constructor(c: CloudConfig, opts: { name?: string; memory?: boolean } = {}) {
    this.app = initializeApp({ apiKey: c.apiKey, authDomain: c.authDomain, projectId: c.projectId, appId: c.appId }, opts.name ?? "nsalek");
    this.auth = initializeAuth(this.app, opts.memory ? { persistence: inMemoryPersistence } : { persistence: [indexedDBLocalPersistence, browserLocalPersistence], popupRedirectResolver: browserPopupRedirectResolver });
    this.db = getFirestore(this.app);
    if (c.emulator) {
      connectAuthEmulator(this.auth, `http://${c.emulator.host}:${c.emulator.auth}`, { disableWarnings: true });
      connectFirestoreEmulator(this.db, c.emulator.host, c.emulator.firestore);
    }
  }

  close() {
    return deleteApp(this.app);
  }

  // -------------------------------------------------------------- account

  /** Called now and at every change; null when nobody is signed in. */
  watch(cb: (a: Account | null) => void): () => void {
    return onIdTokenChanged(this.auth, (u) => cb(u ? accountOf(u) : null));
  }
  private user(): User {
    if (!this.auth.currentUser) throw new CloudError("cloud_denied");
    return this.auth.currentUser;
  }
  setLanguage(lang: string) {
    this.auth.languageCode = lang;
  }
  async signIn(email: string, password: string): Promise<Account> {
    return accountOf((await safe(signInWithEmailAndPassword(this.auth, email.trim(), password))).user);
  }
  async signUp(email: string, password: string): Promise<Account> {
    const { user } = await safe(createUserWithEmailAndPassword(this.auth, email.trim(), password));
    await sendEmailVerification(user).catch(() => undefined); // can be sent again from the screen
    return accountOf(user);
  }
  async google(): Promise<Account> {
    return accountOf((await safe(signInWithPopup(this.auth, this.googleProvider()))).user);
  }
  private googleProvider() {
    const p = new GoogleAuthProvider();
    p.setCustomParameters({ prompt: "select_account" });
    return p;
  }
  /** The answer is the same whether the address has an account or not. */
  async resetPassword(email: string): Promise<void> {
    try {
      await safe(sendPasswordResetEmail(this.auth, email.trim()));
    } catch (e) {
      if ((e as CloudError).code !== "auth_wrong") throw e;
    }
  }
  async sendVerification(): Promise<void> {
    await safe(sendEmailVerification(this.user()));
  }
  /** After the person opened the link in the email. */
  async refresh(): Promise<Account> {
    await safe(reload(this.user()));
    return accountOf(this.user());
  }
  async linkGoogle(): Promise<Account> {
    return accountOf((await safe(linkWithPopup(this.user(), this.googleProvider()))).user);
  }
  async unlinkGoogle(): Promise<Account> {
    return accountOf(await safe(unlink(this.user(), "google.com")));
  }
  async linkPassword(password: string): Promise<Account> {
    const u = this.user();
    return accountOf((await safe(linkWithCredential(u, EmailAuthProvider.credential(u.email ?? "", password)))).user);
  }
  async changePassword(password: string): Promise<void> {
    await safe(updatePassword(this.user(), password));
  }
  /** Before something serious: the person shows again who they are. */
  async confirm(password?: string): Promise<void> {
    const u = this.user();
    if (password !== undefined) await safe(reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email ?? "", password)));
    else await safe(reauthenticateWithPopup(u, this.googleProvider()));
  }
  async signOut(): Promise<void> {
    await safe(signOut(this.auth));
  }
  async deleteAccount(): Promise<void> {
    await safe(deleteUser(this.user()));
  }

  // -------------------------------------------------------------- the copy

  port(uid: string): CloudPort {
    const db = this.db;
    const headRef = doc(db, "users", uid);
    const partRef = (id: string, n: number) => doc(db, "users", uid, "parts", `${id}-${n}`);
    const readHead = () =>
      safe(
        (async () => {
          const s = await getDoc(headRef);
          return s.exists() ? toHead(s.data()) : null;
        })(),
      );
    const follows = (here: Head | null, after: Save["after"]) => (after ? here?.rev === after.rev && here.lineage === after.lineage : here === null);
    const commit = (s: Save) =>
      safe(
        runTransaction(
          db,
          async (tx) => {
            const now = await tx.get(headRef);
            if (!follows(now.exists() ? toHead(now.data()) : null, s.after)) throw new CloudError("cloud_moved");
            tx.set(headRef, { ...s.head, added: s.add.version.id, updatedAt: serverTimestamp() });
            const { version, bytes } = s.add;
            for (let n = 0; n < version.parts; n++) tx.set(partRef(version.id, n), { v: version.id, n, data: Bytes.fromUint8Array(bytes.slice(n * PART_BYTES, (n + 1) * PART_BYTES)) });
            for (const d of s.drop) for (let n = 0; n < d.parts; n++) tx.delete(partRef(d.id, n));
          },
          { maxAttempts: 1 },
        ),
      );
    return {
      head: readHead,
      read: (v: Version) =>
        safe(
          (async () => {
            const parts = await Promise.all(Array.from({ length: v.parts }, (_, n) => getDoc(partRef(v.id, n))));
            const out = new Uint8Array(v.bytes);
            let at = 0;
            for (const p of parts) {
              const b = p.exists() ? (p.data().data as Bytes).toUint8Array() : null;
              if (!b || at + b.length > out.length) throw new CloudError("cloud_corrupt");
              out.set(b, at);
              at += b.length;
            }
            if (at !== out.length) throw new CloudError("cloud_corrupt");
            return out;
          })(),
        ),
      save: (s: Save) =>
        inPace(
          () => commit(s),
          async () => {
            // Refused, perhaps not for coming too soon but for following an older copy.
            if (!follows(await readHead(), s.after)) throw new CloudError("cloud_moved");
          },
        ),
      deleteAll: () =>
        safe(
          (async () => {
            // The head first: without it the parts may be removed, and no phone takes them for a copy.
            await inPace(() => safe(deleteDoc(headRef)));
            for (;;) {
              const some = await getDocs(query(collection(db, "users", uid, "parts"), limit(100)));
              if (some.empty) return;
              const b = writeBatch(db);
              for (const d of some.docs) b.delete(d.ref);
              await b.commit();
            }
          })(),
        ),
    };
  }
}

function toHead(d: Record<string, unknown>): Head {
  const at = d.updatedAt as Timestamp;
  return { lineage: d.lineage as string, rev: d.rev as number, versionId: d.versionId as string, versions: d.versions as Version[], updatedAt: at.toDate().toISOString() };
}

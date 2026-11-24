// One-tap encrypted backup. The passphrase is typed once; the key derived from it stays on this
// device as a non-extractable CryptoKey, so each later backup needs no typing. The file carries the
// salt, so another device rebuilds the key from the passphrase alone.
import { createBackup, openBackup, parseBackup, serializeBackup, validateLedger, type BackupFile } from "./backup.ts";
import { bytesToBase64, base64ToBytes, decryptText, deriveKey, encryptText, PBKDF2_ITERATIONS, randomBytes } from "./crypto.ts";
import type { BackupKey, LedgerData } from "./types.ts";

export async function makeBackupKey(passphrase: string, opts: { iterations?: number; now?: Date } = {}): Promise<BackupKey> {
  const salt = randomBytes(16);
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const at = (opts.now ?? new Date()).toISOString();
  return { key: await deriveKey(passphrase, salt, iterations), salt: bytesToBase64(salt), iterations, createdAt: at, confirmedAt: at };
}

/** True when this passphrase would open the backups made with the key on this device. */
export async function checkPassphrase(key: BackupKey, passphrase: string): Promise<boolean> {
  const probe = await encryptText("nsalek", key);
  const derived = { key: await deriveKey(passphrase, base64ToBytes(key.salt), key.iterations), salt: key.salt, iterations: key.iterations };
  try {
    return (await decryptText(probe.ciphertext, derived, probe.envelope)) === "nsalek";
  } catch {
    return false;
  }
}

const realIds = (data: LedgerData) => data.workspaces.filter((w) => !w.demo).map((w) => w.id);

const pad = (n: number) => String(n).padStart(2, "0");
function fileName(at: Date): string {
  // Chromium only shares a short list of file types; .txt is on it and .json is not.
  return `nsalek-backup-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}.txt`;
}

export type QuickBackup = { name: string; text: string; file: BackupFile; check: { ok: boolean; code?: string } };

/** Backs up every real notebook, then reopens the result exactly as a restore would. */
export async function quickBackup(data: LedgerData, key: BackupKey, opts: { now?: Date; appVersion?: string } = {}): Promise<QuickBackup> {
  const now = opts.now ?? new Date();
  const file = await createBackup(data, { workspaceIds: realIds(data), passphrase: key, now, appVersion: opts.appVersion });
  const text = serializeBackup(file);
  return { name: fileName(now), text, file, check: await verify(text, key) };
}

async function verify(text: string, key: BackupKey): Promise<QuickBackup["check"]> {
  try {
    const issues = validateLedger(await openBackup(parseBackup(text), key));
    return issues.length ? { ok: false, code: "validation_failed" } : { ok: true };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? "integrity_failed" };
  }
}

/** Does this file contain every real notebook that has data? */
export function coversEverything(file: BackupFile, data: LedgerData): boolean {
  const inFile = new Set(file.scope.workspaceIds);
  return realIds(data).every((id) => inFile.has(id));
}

/** Names of the notebooks on this device that a "replace" restore of this file would remove. */
export function notebooksLost(file: BackupFile, data: LedgerData): string[] {
  const inFile = new Set(file.scope.workspaceIds);
  return data.workspaces.filter((w) => !w.demo && !inFile.has(w.id)).map((w) => w.name);
}

// ---------------------------------------------------------------- reminders

export type BackupStatus = { level: "none" | "ok" | "due" | "urgent"; changes: number; days: number | null };

const DAY = 86_400_000;

/**
 * Based on what would be lost, not only on age: an old backup is fine while nothing changed since.
 * Every command writes audit events, so they count the unsaved changes.
 */
export function backupStatus(data: LedgerData, lastBackupAt: string | null | undefined, now: Date): BackupStatus {
  const real = new Set(realIds(data));
  const hasData = data.parties.some((p) => real.has(p.workspaceId)) || data.obligations.some((o) => real.has(o.workspaceId));
  if (!hasData) return { level: "none", changes: 0, days: null };
  let changes = 0;
  let first: string | null = null;
  for (const e of data.audit) {
    if (!real.has(e.workspaceId)) continue;
    // ">=": an entry in the same millisecond may have missed the backup.
    if (lastBackupAt && e.at < lastBackupAt) continue;
    changes++;
    if (first === null || e.at < first) first = e.at;
  }
  const since = (iso: string) => Math.max(0, now.getTime() - Date.parse(iso));
  if (!lastBackupAt) {
    const urgent = changes >= 10 || (first !== null && since(first) > 3 * DAY);
    return { level: urgent ? "urgent" : "due", changes, days: null };
  }
  const age = since(lastBackupAt);
  const days = Math.floor(age / DAY);
  if (!changes) return { level: "ok", changes, days };
  const level = age >= 7 * DAY || changes >= 60 ? "urgent" : age >= 3 * DAY || changes >= 20 ? "due" : "ok";
  return { level, changes, days };
}

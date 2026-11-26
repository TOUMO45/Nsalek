// The person's own Google Drive as the copy engine sees it: a hidden folder that only Nsalek can
// open (Google's "appDataFolder"). http.ts talks to Google; fake.ts stands in for it in tests and
// in development.

export type DriveFile = { id: string; name: string; createdTime: string; size: number; appProperties: Record<string, string> };

export type DriveAbout = { email?: string; usage?: number; limit?: number };

export interface DrivePort {
  /** Every file in the hidden folder. */
  list(): Promise<DriveFile[]>;
  upload(name: string, bytes: Uint8Array<ArrayBuffer>, appProperties: Record<string, string>): Promise<DriveFile>;
  download(id: string): Promise<Uint8Array<ArrayBuffer>>;
  /** Removing what is already gone is not an error. */
  remove(id: string): Promise<void>;
  about(): Promise<DriveAbout>;
}

/**
 * drive_auth: Google's permission ended (about an hour) or was taken back; a tap asks again.
 * drive_full: the person's Google storage is full. drive_offline / drive_busy: try later.
 * drive_damaged: a copy does not match its fingerprint. drive_invalid: the notebook breaks a
 * ledger rule, so no copy is made that could not be put back.
 */
export type DriveCode =
  | "drive_auth"
  | "drive_full"
  | "drive_offline"
  | "drive_busy"
  | "drive_denied"
  | "drive_off"
  | "drive_gone"
  | "drive_damaged"
  | "drive_invalid"
  | "drive_closed"
  | "drive_popup"
  | "drive_scope"
  | "drive_failed";

export class DriveError extends Error {
  code: DriveCode;
  constructor(code: DriveCode) {
    super(code);
    this.name = "DriveError";
    this.code = code;
  }
}

export const codeOfDrive = (e: unknown): DriveCode => (e instanceof DriveError ? e.code : "drive_failed");

// Google's permission to use Nsalek's hidden folder in the person's Drive (scope drive.appdata:
// Nsalek sees only its own folder, never the person's files). Google Identity Services, token
// model: there is no server, so the permission lasts about an hour and a new one needs a tap.
// The token stays in memory and is never stored.
import { DriveError } from "./port.ts";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const SCRIPT = "https://accounts.google.com/gsi/client";

export type Grant = { token: string; expiresAt: number };

type TokenResponse = { access_token?: string; expires_in?: number | string; error?: string };
type Oauth2 = {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    prompt?: string;
    login_hint?: string;
    callback: (r: TokenResponse) => void;
    error_callback?: (e: { type?: string }) => void;
  }): { requestAccessToken(): void };
  hasGrantedAllScopes(r: TokenResponse, ...scopes: string[]): boolean;
  revoke(token: string, done?: () => void): void;
};
const oauth2 = () => (globalThis as { google?: { accounts?: { oauth2?: Oauth2 } } }).google?.accounts?.oauth2;

let loading: Promise<void> | null = null;

/** Loads Google's script ahead of the tap: the window must open within the tap itself. */
export function loadGoogle(): Promise<void> {
  if (oauth2()) return Promise.resolve();
  loading ??= new Promise<void>((ok, fail) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (oauth2() ? ok() : fail(new DriveError("drive_offline")));
    s.onerror = () => {
      s.remove();
      loading = null;
      fail(new DriveError("drive_offline"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export const googleReady = () => !!oauth2();

/** Call only from a tap. Resolves with a fresh permission, or tells why there is none. */
export function askGoogle(clientId: string, hint?: string): Promise<Grant> {
  return new Promise((ok, fail) => {
    const g = oauth2();
    if (!g) return fail(new DriveError("drive_offline"));
    const client = g.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      prompt: "",
      ...(hint ? { login_hint: hint } : {}),
      callback: (r) => {
        if (r.error || !r.access_token) return fail(new DriveError(r.error === "access_denied" ? "drive_closed" : "drive_failed"));
        // The person may untick the Drive box on Google's page.
        if (!g.hasGrantedAllScopes(r, DRIVE_SCOPE)) return fail(new DriveError("drive_scope"));
        ok({ token: r.access_token, expiresAt: Date.now() + Number(r.expires_in ?? 3600) * 1000 });
      },
      error_callback: (e) => fail(new DriveError(e?.type === "popup_failed_to_open" ? "drive_popup" : e?.type === "popup_closed" ? "drive_closed" : "drive_failed")),
    });
    client.requestAccessToken();
  });
}

export function revokeGoogle(token: string): void {
  try {
    oauth2()?.revoke(token, () => undefined);
  } catch {
    // the permission ends by itself within the hour
  }
}

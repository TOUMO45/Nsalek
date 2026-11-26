// What went wrong, in terms a person can act on.
import { CloudError } from "./port.ts";

/** Firebase's many codes, reduced to what a person can act on. */
export function cloudError(e: unknown): CloudError {
  const code = String((e as { code?: string })?.code ?? "");
  if (e instanceof CloudError) return e;
  if (/unavailable|network-request-failed|deadline-exceeded|timeout/.test(code) || e instanceof TypeError) return new CloudError("cloud_offline");
  // A request that never left (no internet behind the Wi-Fi) is "unknown" to Firestore.
  if (code === "unknown" && /request failed|fetch|network|load failed/i.test(String((e as Error).message))) return new CloudError("cloud_offline");
  if (/resource-exhausted|quota-exceeded/.test(code)) return new CloudError("cloud_quota");
  if (/permission-denied|unauthenticated|user-token-expired|user-disabled|user-not-found|invalid-user-token/.test(code) && !code.startsWith("auth/user-not-found")) return new CloudError("cloud_denied");
  if (/aborted|failed-precondition|already-exists/.test(code)) return new CloudError("cloud_moved");
  const auth: Record<string, string> = {
    "auth/invalid-credential": "auth_wrong",
    "auth/wrong-password": "auth_wrong",
    "auth/user-not-found": "auth_wrong",
    "auth/invalid-login-credentials": "auth_wrong",
    "auth/invalid-email": "auth_email",
    "auth/missing-email": "auth_email",
    "auth/email-already-in-use": "auth_taken",
    "auth/weak-password": "auth_weak",
    "auth/password-does-not-meet-requirements": "auth_weak",
    "auth/missing-password": "auth_weak",
    "auth/too-many-requests": "auth_slow",
    "auth/popup-blocked": "auth_popup",
    "auth/operation-not-supported-in-this-environment": "auth_popup",
    "auth/web-storage-unsupported": "auth_popup",
    "auth/popup-closed-by-user": "auth_closed",
    "auth/cancelled-popup-request": "auth_closed",
    "auth/user-cancelled": "auth_closed",
    "auth/requires-recent-login": "auth_again",
    "auth/user-mismatch": "auth_mismatch",
    "auth/credential-already-in-use": "auth_google_used",
    "auth/provider-already-linked": "auth_linked",
    "auth/account-exists-with-different-credential": "auth_other_way",
    "auth/operation-not-allowed": "auth_off",
    "auth/unauthorized-domain": "auth_off",
    "auth/configuration-not-found": "auth_off",
  };
  return new CloudError(auth[code] ?? (code.startsWith("auth/") ? "auth_failed" : "cloud_failed"));
}

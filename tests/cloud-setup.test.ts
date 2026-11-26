// Timing, texts, published headers and the check before publishing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudError } from "../lib/cloud/errors.ts";
import { MIN_GAP, SETTLE, waitAfterError, waitBeforeSave } from "../lib/cloud/schedule.ts";
import { accountError, accountText } from "../lib/ui/accountText.ts";
import { releaseProblems } from "../scripts/check-release.mjs";

test("saves wait for quiet, keep a distance, and a slow phone gets more room", () => {
  assert.equal(waitBeforeSave(1_000_000, 0, 0), SETTLE);
  assert.equal(waitBeforeSave(1_000_000, 999_000, 100), MIN_GAP - 1000);
  assert.equal(waitBeforeSave(1_000_000, 1_000_000, 10_000), 40_000);
  assert.equal(waitBeforeSave(1_000_000, 1_000_000, 10 ** 7), 5 * 60_000, "never more than five minutes");
});

test("errors are tried again at growing distances; only the person can repair the others", () => {
  assert.ok(waitAfterError("cloud_offline", 1)! < waitAfterError("cloud_offline", 4)!);
  assert.equal(waitAfterError("cloud_offline", 50), 5 * 60_000);
  assert.ok(waitAfterError("cloud_quota", 1)! >= 10 * 60_000);
  assert.ok(waitAfterError("cloud_moved", 1)! > 2000, "longer than the pace rule");
  for (const c of ["cloud_denied", "cloud_corrupt", "cloud_update_app", "cloud_too_big"]) assert.equal(waitAfterError(c, 1), null);
});

test("a request that cannot leave the phone is \"no connection\", not a failure", () => {
  const is = (code: string, message = "") => cloudError(Object.assign(new Error(message), { code })).code;
  assert.equal(is("unknown", "Request failed with error: Failed to fetch"), "cloud_offline");
  assert.equal(is("unknown", "Request failed with error: Load failed"), "cloud_offline");
  assert.equal(is("unavailable"), "cloud_offline");
  assert.equal(is("auth/network-request-failed"), "cloud_offline");
  assert.equal(cloudError(new TypeError("Failed to fetch")).code, "cloud_offline");
  assert.equal(is("unknown", "something else"), "cloud_failed");
  assert.equal(is("resource-exhausted"), "cloud_quota");
  assert.equal(is("permission-denied"), "cloud_denied");
  assert.equal(is("auth/user-not-found"), "auth_wrong");
  assert.equal(is("auth/anything-new"), "auth_failed");
});

test("every account text and error exists in the three languages, and no code is shown to a person", () => {
  const src = readFileSync("lib/ui/accountText.ts", "utf8");
  const keys = [...src.matchAll(/^ {2}(\w+): \[/gm)].map((m) => m[1]);
  assert.ok(keys.length > 100);
  for (const l of ["ar", "fr", "en"] as const) {
    assert.ok(accountText(l, "title").length > 3);
    for (const file of ["lib/cloud/errors.ts", "lib/cloud/firebase.ts", "lib/cloud/sync.ts", "lib/cloud/bundle.ts"])
      for (const [, code] of readFileSync(file, "utf8").matchAll(/"((?:cloud|auth)_\w+)"/g)) {
        if (["cloud_base", "cloud_pending", "cloud_replaced", "cloud_deleted", "cloud_unreadable"].includes(code)) continue;
        const text = accountError(l, code);
        assert.ok(!text.includes(code), `${code} has no ${l} text: ${text}`);
      }
  }
  assert.match(accountText("ar", "title"), /[؀-ۿ]/);
});

test("the screens use only texts that exist", () => {
  const known = new Set([...readFileSync("lib/ui/accountText.ts", "utf8").matchAll(/^ {2}(\w+): \[/gm)].map((m) => m[1]));
  for (const [, k] of readFileSync("app/ui/Account.tsx", "utf8").matchAll(/\ba\("(\w+)"\)/g)) assert.ok(known.has(k), k);
  for (const s of ["idle", "working", "waiting", "saved", "empty", "offline", "quota", "choose", "foreign", "error"]) assert.ok(known.has("st_" + s), s);
  for (const r of ["both_changed", "first_link", "cloud_replaced", "cloud_deleted", "cloud_unreadable"]) assert.ok(known.has("choose_" + r), r);
});

test("the published headers let sign-in, the copy and the Google Drive copy through, and nothing else", () => {
  const hosting = JSON.parse(readFileSync("firebase.json", "utf8")).hosting;
  const csp: string = hosting.headers[0].headers.find((h: { key: string }) => h.key === "Content-Security-Policy").value;
  const part = (name: string) => csp.split(";").map((x) => x.trim()).find((x) => x.startsWith(name + " "))!.split(" ").slice(1);
  assert.deepEqual(part("connect-src"), ["'self'", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://firestore.googleapis.com", "https://www.googleapis.com", "https://accounts.google.com/gsi/", "https://oauth2.googleapis.com/revoke"]);
  assert.deepEqual(part("script-src"), ["'self'", "'unsafe-inline'", "https://apis.google.com", "https://accounts.google.com/gsi/client"]);
  assert.deepEqual(part("frame-src"), ["https://nsalek-app.firebaseapp.com", "https://accounts.google.com/gsi/"]);
  // Google checks where its window was opened from: the address of the site only, never the page.
  assert.equal(hosting.headers[0].headers.find((h: { key: string }) => h.key === "Referrer-Policy").value, "strict-origin-when-cross-origin");
  assert.deepEqual(part("frame-ancestors"), ["'none'"]);
  assert.match(JSON.stringify(hosting.predeploy), /check-release/);
});

test("a build for the emulators, without accounts, or of another project is not published", () => {
  const dir = mkdtempSync(join(tmpdir(), "nsalek-"));
  mkdirSync(join(dir, "_next", "static", "chunks"), { recursive: true });
  const write = (s: string) => writeFileSync(join(dir, "_next", "static", "chunks", "a.js"), s);
  const key = `,k:"AIza${"x".repeat(35)}"`;
  write(`x={projectId:"nsalek-app"${key}}`);
  assert.deepEqual(releaseProblems(dir), []);
  write("x=1");
  assert.equal(releaseProblems(dir).length, 2);
  write('x={projectId:"nsalek-app",k:"x"}');
  assert.match(releaseProblems(dir)[0], /placeholder/);
  write(`x={projectId:"demo-nsalek"${key}}`);
  assert.equal(releaseProblems(dir).length, 2);
  write(`x={projectId:"nsalek-app",y:"konashi-1"${key}}`);
  assert.equal(releaseProblems(dir).length, 1);
});

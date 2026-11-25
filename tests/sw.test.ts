// The service worker on a real host: an error page or another page must never replace the app that
// opens offline. Runs public/sw.js itself with a small fake of the browser's cache and network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { keepOfflineCopy } from "../lib/ui/offline.ts";

const ORIGIN = "https://app.example";
type Answer = { body: string; ok?: boolean; type?: string };
const SHELL = ["/", "/app.js", "/font.woff2"];

function worker(answers: Record<string, Answer | "offline">, opts: { drop?: Record<string, number>; store?: Map<string, string>; slow?: Record<string, number> } = {}) {
  const store = opts.store ?? new Map<string, string>();
  const asked: string[] = [];
  const drop = { ...opts.drop };
  const handlers: Record<string, (e: unknown) => void> = {};
  const key = (r: string | { url: string }) => new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
  const response = (a: Answer) => ({ ok: a.ok ?? true, type: a.type ?? "basic", body: a.body, clone: () => response(a) });
  const match = async (r: string | { url: string }) => (store.has(key(r)) ? response({ body: store.get(key(r))! }) : undefined);
  const load = async (r: string | { url: string }) => {
    const k = key(r);
    asked.push(k);
    if (drop[k]) {
      drop[k]--;
      throw new TypeError("Failed to fetch");
    }
    const a = answers[k];
    if (!a || a === "offline") throw new TypeError("Failed to fetch");
    if (opts.slow?.[k]) await new Promise((r) => setTimeout(r, opts.slow![k]));
    return response(a);
  };
  const cache = {
    match,
    put: async (r: string | { url: string }, res: { body: string }) => void store.set(key(r), res.body),
    // as in browsers: all files or none
    addAll: async (list: string[]) => {
      const all = await Promise.all(list.map(load));
      if (all.some((x) => !x.ok)) throw new TypeError("Request failed");
      list.forEach((p, i) => store.set(p, all[i].body));
    },
  };
  const self = { location: { origin: ORIGIN }, addEventListener: (n: string, f: (e: unknown) => void) => void (handlers[n] = f), skipWaiting: () => {}, clients: { claim: () => {} } };
  const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8").replace(/const PRECACHE = \[[^\]]*\];/, `const PRECACHE = ${JSON.stringify(SHELL)};`);
  runInNewContext(source, {
    self,
    URL,
    Promise,
    Error,
    setTimeout: (f: () => void) => setTimeout(f, 0),
    caches: { open: async () => cache, keys: async () => [], match },
    fetch: load,
  });
  const install = async () => {
    let done: Promise<unknown> = Promise.resolve();
    handlers.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  const open = async (path: string) => {
    let reply: Promise<{ body: string; type: string }> | undefined;
    handlers.fetch({ request: { method: "GET", mode: "navigate", url: ORIGIN + path }, respondWith: (p: Promise<{ body: string; type: string }>) => (reply = p) });
    const res = await reply!;
    await new Promise((r) => setTimeout(r, 5)); // let the cache write finish
    return res;
  };
  return { open, install, answers, store, asked };
}

test("service worker: the app opened online is the one that opens offline", async () => {
  const w = worker({ "/": { body: "app" } });
  assert.equal((await w.open("/")).body, "app");
  w.answers["/"] = "offline";
  assert.equal((await w.open("/")).body, "app");
});

test("service worker: a host error page is not kept as the app, and the kept app is shown instead", async () => {
  const w = worker({ "/": { body: "app" } });
  await w.open("/");
  w.answers["/"] = { body: "503 error", ok: false };
  assert.equal((await w.open("/")).body, "app");
  w.answers["/"] = "offline";
  assert.equal((await w.open("/")).body, "app");
});

test("service worker: with nothing kept yet, the host's own answer is shown", async () => {
  const w = worker({ "/": { body: "503 error", ok: false } });
  assert.equal((await w.open("/")).body, "503 error");
  assert.equal(w.store.size, 0);
});

test("service worker: opening another page does not replace the app", async () => {
  const w = worker({ "/": { body: "app" }, "/sample-statement": { body: "statement" } });
  await w.open("/");
  assert.equal((await w.open("/sample-statement")).body, "statement");
  w.answers["/"] = "offline";
  assert.equal((await w.open("/")).body, "app");
});

test("service worker: redirects are left to the browser", async () => {
  const w = worker({ "/": { body: "app" }, "/x/": { body: "", ok: false, type: "opaqueredirect" } });
  await w.open("/");
  assert.equal((await w.open("/x/")).type, "opaqueredirect");
});

// ---------------------------------------------------------------- first visit on a bad connection

const FILES = { "/": { body: "app" }, "/app.js": { body: "js" }, "/font.woff2": { body: "font" } };

test("service worker: a file dropped once by the network does not lose the offline copy", async () => {
  const w = worker(FILES, { drop: { "/font.woff2": 1 } });
  await w.install();
  assert.deepEqual([...w.store.keys()].sort(), [...SHELL].sort());
});

test("service worker: an install that fails keeps what it downloaded, and the next try asks only for the rest", async () => {
  const w = worker({ ...FILES, "/font.woff2": "offline" });
  await assert.rejects(w.install(), /Failed to fetch/);
  const later = worker(FILES, { store: w.store });
  await later.install();
  assert.deepEqual(later.asked, ["/font.woff2"]);
  assert.equal(later.store.size, 3);
});

test("service worker: a file that fails does not cut short the slower ones", async () => {
  const w = worker({ ...FILES, "/app.js": "offline" }, { slow: { "/font.woff2": 150 } });
  await assert.rejects(w.install(), /Failed to fetch/);
  assert.equal(w.store.has("/font.woff2"), true);
});

test("service worker: the offline copy is never called complete with a file missing or an error page in it", async () => {
  const gone = worker({ ...FILES, "/app.js": { body: "404 page", ok: false } });
  await assert.rejects(gone.install());
  assert.equal(gone.store.has("/app.js"), false);
});

// A browser's registration: every try either ends up active or is thrown away.
function browser(outcomes: ("active" | "redundant" | "refused")[]) {
  let tries = 0;
  const waiting: { run: () => void; ms: number }[] = [];
  let wake = () => {};
  const sw = {
    register: async () => {
      const o = outcomes[Math.min(tries++, outcomes.length - 1)];
      if (o === "refused") throw new TypeError("Failed to register");
      const w = Object.assign(new EventTarget(), { state: "installing" });
      queueMicrotask(() => queueMicrotask(() => {
        w.state = o === "active" ? "activated" : "redundant";
        w.dispatchEvent(new Event("statechange"));
      }));
      return { active: null, waiting: null, installing: w };
    },
  };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    sw,
    env: { later: (run: () => void, ms: number) => void waiting.push({ run, ms }), onWake: (f: () => void) => void (wake = f) },
    tries: () => tries,
    delays: () => waiting.map((x) => x.ms),
    settle,
    wake: async () => { wake(); await settle(); },
    elapse: async () => { waiting.shift()?.run(); await settle(); },
  };
}

test("offline copy: a first visit that works is not repeated", async () => {
  const b = browser(["active"]);
  keepOfflineCopy(b.sw, b.env);
  await b.settle();
  await b.wake();
  assert.deepEqual([b.tries(), b.delays()], [1, []]);
});

test("offline copy: a download that failed is tried again while the app stays open", async () => {
  const b = browser(["redundant", "refused", "active"]);
  keepOfflineCopy(b.sw, b.env);
  await b.settle();
  assert.equal(b.tries(), 1);
  await b.elapse();
  await b.elapse();
  assert.equal(b.tries(), 3);
  await b.wake();
  assert.deepEqual([b.tries(), b.delays()], [3, []]);
});

test("offline copy: coming back online or to the app tries again at once, never twice together", async () => {
  const b = browser(["redundant", "active"]);
  keepOfflineCopy(b.sw, b.env);
  await b.settle();
  void b.wake();
  await b.wake();
  assert.equal(b.tries(), 2);
  await b.elapse(); // the old timer finds nothing to do
  assert.equal(b.tries(), 2);
});

test("offline copy: where the browser always refuses, the timed tries stop", async () => {
  const b = browser(["refused"]);
  keepOfflineCopy(b.sw, b.env);
  await b.settle();
  for (let i = 0; i < 10; i++) await b.elapse();
  assert.ok(b.tries() <= 5, String(b.tries()));
  assert.deepEqual(b.delays(), []);
});

test("offline copy: a worker already active from an earlier visit counts as done", async () => {
  let tries = 0;
  const b = browser(["active"]);
  keepOfflineCopy({ register: async () => (tries++, { active: {}, waiting: null, installing: null }) } as never, b.env);
  await b.settle();
  await b.wake();
  assert.equal(tries, 1);
});

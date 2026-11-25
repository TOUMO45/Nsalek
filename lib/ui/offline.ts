// Keeps a copy of the app on the phone for offline use. A browser throws a worker away when its
// download fails and says nothing, so on a bad connection the app has to ask again by itself.

type Worker = EventTarget & { state: string };
type Container = { register(url: string): Promise<{ active: unknown; waiting: Worker | null; installing: Worker | null }> };
type Env = { later(run: () => void, ms: number): void; /** back online, or back in the app */ onWake(run: () => void): void };

const WAITS = [20_000, 60_000, 180_000, 600_000];

async function install(sw: Container): Promise<boolean> {
  const reg = await sw.register("/sw.js");
  if (reg.active) return true; // later builds are the browser's own job
  const worker = reg.installing ?? reg.waiting;
  if (!worker) return false;
  return new Promise((done) => {
    const check = () => {
      if (worker.state === "activated") done(true);
      if (worker.state === "redundant") done(false);
    };
    worker.addEventListener("statechange", check);
    check();
  });
}

/** Tries until the offline copy is complete: a few timed tries, then each time the app wakes. */
export function keepOfflineCopy(sw: Container, env: Env): void {
  let ready = false;
  let trying = false;
  let timed = 0;
  const attempt = async () => {
    if (ready || trying) return;
    trying = true;
    ready = await install(sw).catch(() => false);
    trying = false;
    if (!ready && timed < WAITS.length) env.later(() => void attempt(), WAITS[timed++]);
  };
  env.onWake(() => void attempt());
  void attempt();
}

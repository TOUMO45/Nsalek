// Google Drive's REST API (v3), only inside the hidden app folder. The access token comes from
// google.ts and lives in memory only; nothing here keeps it.
import { DriveError, type DriveAbout, type DriveCode, type DriveFile, type DrivePort } from "./port.ts";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,createdTime,size,appProperties";
/** Above this, the upload goes in two steps, as Google advises for bigger files. */
export const SIMPLE_MAX = 4_000_000;
/** Time allowed to send: a minute, plus a slow phone connection (20 KB/s). */
const slow = (bytes: number) => 60_000 + Math.ceil(bytes / 20);

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Google's answer, reduced to what a person can act on. */
export async function driveErrorOf(res: Response): Promise<DriveError> {
  let reason = "";
  try {
    const body = (await res.json()) as { error?: { errors?: { reason?: string }[]; status?: string } };
    reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
  } catch {
    // not JSON: the status decides
  }
  const code: DriveCode =
    res.status === 401
      ? "drive_auth"
      : res.status === 403
        ? /storageQuotaExceeded/.test(reason)
          ? "drive_full"
          : /rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded|dailyLimitExceeded|quotaExceeded/.test(reason)
            ? "drive_busy"
            : /accessNotConfigured|SERVICE_DISABLED|domainPolicy/.test(reason)
              ? "drive_off"
              : "drive_denied"
        : res.status === 404
          ? "drive_gone"
          : res.status === 429 || res.status >= 500
            ? "drive_busy"
            : "drive_failed";
  return new DriveError(code);
}

const toFile = (f: { id: string; name: string; createdTime: string; size?: string | number; appProperties?: Record<string, string> }): DriveFile => ({
  id: f.id,
  name: f.name,
  createdTime: f.createdTime,
  size: Number(f.size ?? 0),
  appProperties: f.appProperties ?? {},
});

export class HttpDrive implements DrivePort {
  private token: (lenient?: boolean) => string | null;
  private fetcher: Fetch;
  /** `token(true)` may give a permission about to end: to finish what has begun, never to begin. */
  constructor(token: (lenient?: boolean) => string | null, fetcher: Fetch = (u, i) => fetch(u, i)) {
    this.token = token;
    this.fetcher = fetcher;
  }

  /** A request that never answers would stop every later copy: it fails as "offline" instead. */
  private async send(url: string, init: RequestInit, ms: number): Promise<Response> {
    try {
      return await this.fetcher(url, { ...init, signal: AbortSignal.timeout(ms) });
    } catch {
      throw new DriveError("drive_offline");
    }
  }

  private async call(url: string, init: RequestInit = {}, ok404 = false, opts: { ms?: number; lenient?: boolean } = {}): Promise<Response> {
    const t = this.token(opts.lenient);
    if (!t) throw new DriveError("drive_auth");
    const res = await this.send(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${t}` } }, opts.ms ?? 60_000);
    if (res.ok || (ok404 && res.status === 404)) return res;
    throw await driveErrorOf(res);
  }

  async list(): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let page = "";
    do {
      const q = new URLSearchParams({ spaces: "appDataFolder", pageSize: "1000", q: "trashed = false", fields: `nextPageToken,files(${FIELDS})` });
      if (page) q.set("pageToken", page);
      const body = (await (await this.call(`${API}/files?${q}`)).json()) as { nextPageToken?: string; files?: Parameters<typeof toFile>[0][] };
      out.push(...(body.files ?? []).map(toFile));
      page = body.nextPageToken ?? "";
    } while (page);
    return out;
  }

  async upload(name: string, bytes: Uint8Array<ArrayBuffer>, appProperties: Record<string, string>): Promise<DriveFile> {
    const meta = { name, parents: ["appDataFolder"], mimeType: "application/octet-stream", appProperties };
    if (bytes.length <= SIMPLE_MAX) {
      const boundary = `nsalek${crypto.randomUUID().replaceAll("-", "")}`;
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        bytes,
        `\r\n--${boundary}--`,
      ]);
      const res = await this.call(`${UPLOAD}?uploadType=multipart&fields=${FIELDS}`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }, false, { ms: slow(bytes.length) });
      return toFile(await res.json());
    }
    const start = await this.call(`${UPLOAD}?uploadType=resumable&fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": String(bytes.length) },
      body: JSON.stringify(meta),
    });
    const at = start.headers.get("Location");
    if (!at) throw new DriveError("drive_failed");
    const res = await this.send(at, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: new Blob([bytes]) }, slow(bytes.length));
    if (!res.ok) throw await driveErrorOf(res);
    // The labels are asked for again rather than trusted from the last step's answer; the file is
    // already in Drive, so a permission about to end still serves.
    const { id } = (await res.json()) as { id: string };
    return toFile(await (await this.call(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`, {}, false, { lenient: true })).json());
  }

  async download(id: string): Promise<Uint8Array<ArrayBuffer>> {
    const res = await this.call(`${API}/files/${encodeURIComponent(id)}?alt=media`, {}, false, { ms: 10 * 60_000 });
    return new Uint8Array(await res.arrayBuffer());
  }

  async remove(id: string): Promise<void> {
    await this.call(`${API}/files/${encodeURIComponent(id)}`, { method: "DELETE" }, true);
  }

  async about(): Promise<DriveAbout> {
    const body = (await (await this.call(`${API}/about?fields=user(emailAddress),storageQuota(limit,usage)`)).json()) as {
      user?: { emailAddress?: string };
      storageQuota?: { limit?: string; usage?: string };
    };
    const n = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : undefined);
    return { email: body.user?.emailAddress, usage: n(body.storageQuota?.usage), limit: n(body.storageQuota?.limit) };
  }
}

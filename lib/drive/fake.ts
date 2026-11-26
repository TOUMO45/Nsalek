// A Google Drive that lives in memory (tests) or in this browser's storage (development, with
// NEXT_PUBLIC_DRIVE_FAKE=1). Never used by a production build.
import { DriveError, type DriveAbout, type DriveFile, type DrivePort } from "./port.ts";

type Saved = DriveFile & { data: string };

/** Where the fake keeps its files: a plain object, or localStorage in the browser. */
export type FakeShelf = { load(): Saved[]; save(files: Saved[]): void };

export const memoryShelf = (): FakeShelf => {
  let files: Saved[] = [];
  return { load: () => files.map((f) => ({ ...f, appProperties: { ...f.appProperties } })), save: (f) => void (files = f) };
};

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const strip = (f: Saved): DriveFile => ({ id: f.id, name: f.name, createdTime: f.createdTime, size: f.size, appProperties: { ...f.appProperties } });
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;

export class FakeDrive implements DrivePort {
  /** Set to make the next calls fail as Google would. */
  failWith: DriveError["code"] | null = null;
  full = false;
  limit = 15 * 1024 ** 3;
  email = "person@example.com";
  calls: string[] = [];
  private n = 0;
  private shelf: FakeShelf;
  constructor(shelf: FakeShelf = memoryShelf()) {
    this.shelf = shelf;
  }

  private check(op: string) {
    this.calls.push(op);
    if (this.failWith) throw new DriveError(this.failWith);
  }
  async list(): Promise<DriveFile[]> {
    this.check("list");
    return this.shelf.load().map(strip);
  }
  async upload(name: string, bytes: Uint8Array<ArrayBuffer>, appProperties: Record<string, string>): Promise<DriveFile> {
    this.check("upload");
    if (this.full) throw new DriveError("drive_full");
    const f: Saved = { id: `f${Date.now().toString(36)}${(this.n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, createdTime: new Date().toISOString(), size: bytes.length, appProperties: { ...appProperties }, data: b64(bytes) };
    this.shelf.save([...this.shelf.load(), f]);
    return strip(f);
  }
  async download(id: string): Promise<Uint8Array<ArrayBuffer>> {
    this.check("download");
    const f = this.shelf.load().find((x) => x.id === id);
    if (!f) throw new DriveError("drive_gone");
    return unb64(f.data);
  }
  async remove(id: string): Promise<void> {
    this.check("remove");
    this.shelf.save(this.shelf.load().filter((x) => x.id !== id));
  }
  async about(): Promise<DriveAbout> {
    this.check("about");
    const usage = this.shelf.load().reduce((n, f) => n + f.size, 0);
    return { email: this.email, usage: this.full ? this.limit : usage, limit: this.limit };
  }
  /** Test helper: change a stored copy as a broken upload or a bad disk would. */
  spoil(id: string) {
    const all = this.shelf.load();
    const f = all.find((x) => x.id === id)!;
    const bytes = unb64(f.data);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    f.data = b64(bytes);
    this.shelf.save(all);
  }
}

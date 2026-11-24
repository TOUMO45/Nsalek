// Hands a finished backup file to the phone's share sheet (Drive, WhatsApp, e-mail…) or saves it.

export type Delivery = "shared" | "downloaded" | "cancelled" | "tap_again";

export type DeliverDeps = {
  nav: { canShare?: (d: ShareData) => boolean; share?: (d: ShareData) => Promise<void> };
  download: (name: string, text: string, mime: string) => void;
};

const MIME = "text/plain";
const toFile = (name: string, text: string) => new File([text], name, { type: MIME });

export function canShareFiles(nav: DeliverDeps["nav"]): boolean {
  try {
    return !!nav.share && !!nav.canShare?.({ files: [toFile("a.txt", "a")] });
  } catch {
    return false;
  }
}

/**
 * - "cancelled": the share sheet was closed, so nothing left the device.
 * - "tap_again": the browser requires a fresh tap (preparing the file took too long).
 */
export async function deliverBackup(name: string, text: string, prefer: "share" | "download", deps: DeliverDeps): Promise<Delivery> {
  if (prefer === "share" && canShareFiles(deps.nav)) {
    try {
      await deps.nav.share!({ files: [toFile(name, text)], title: name });
      return "shared";
    } catch (e) {
      const kind = (e as Error)?.name;
      if (kind === "AbortError") return "cancelled";
      if (kind === "NotAllowedError") return "tap_again";
      // Any other failure: keep the backup rather than lose it.
    }
  }
  deps.download(name, text, MIME);
  return "downloaded";
}

// Thin wrappers over WebCrypto (browser and Node ≥ 20). No custom cryptography.
const enc = new TextEncoder();
const dec = new TextDecoder();

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("crypto_unavailable");
  return s;
};

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunks are a multiple of 3 bytes, so their base64 encodings concatenate without padding.
  const chunk = 3 * 16384;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[])));
  return parts.join("");
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await subtle().digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export const PBKDF2_ITERATIONS = 310_000;

/** The returned key is non-extractable: it can be stored and used, but never read out. */
export async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await subtle().importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export type Envelope = { alg: "AES-GCM-256"; kdf: "PBKDF2-SHA-256"; iterations: number; salt: string; iv: string };

/** A passphrase-derived key with the parameters needed to derive it again elsewhere. */
export type DerivedKey = { key: CryptoKey; salt: string; iterations: number };

export async function encryptText(plain: string, secret: string | DerivedKey, iterations = PBKDF2_ITERATIONS): Promise<{ envelope: Envelope; ciphertext: string }> {
  const salt = typeof secret === "string" ? randomBytes(16) : base64ToBytes(secret.salt);
  const rounds = typeof secret === "string" ? iterations : secret.iterations;
  const iv = randomBytes(12); // fresh for every message, also when the key is reused
  const key = typeof secret === "string" ? await deriveKey(secret, salt, rounds) : secret.key;
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain));
  return {
    envelope: { alg: "AES-GCM-256", kdf: "PBKDF2-SHA-256", iterations: rounds, salt: bytesToBase64(salt), iv: bytesToBase64(iv) },
    ciphertext: bytesToBase64(new Uint8Array(ct)),
  };
}

/** Throws Error("wrong_passphrase") when authentication fails (wrong passphrase or tampering). */
export async function decryptText(ciphertext: string, secret: string | DerivedKey, envelope: Envelope): Promise<string> {
  const key = typeof secret === "string" ? await deriveKey(secret, base64ToBytes(envelope.salt), envelope.iterations) : secret.key;
  try {
    const plain = await subtle().decrypt({ name: "AES-GCM", iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(ciphertext));
    return dec.decode(plain);
  } catch {
    throw new Error("wrong_passphrase");
  }
}

/** Salted PBKDF2 hash for the app-lock PIN. The PIN lock is a privacy screen, not encryption. */
export async function hashPin(pin: string, salt?: string, iterations = 200_000) {
  const s = salt ?? bytesToBase64(randomBytes(16));
  const base = await subtle().importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: base64ToBytes(s), iterations }, base, 256);
  return { salt: s, hash: hex(bits), iterations };
}

export async function verifyPin(pin: string, stored: { salt: string; hash: string; iterations: number }) {
  const h = await hashPin(pin, stored.salt, stored.iterations);
  return h.hash === stored.hash;
}

// The cloud as the engine sees it. Firebase is one implementation (firebase.ts); tests use another.
import type { Encoding } from "./bundle.ts";

export type Version = {
  id: string;
  rev: number;
  /** When the server kept it. The newest entry has the phone's time until the next save corrects it. */
  at: string;
  device: string;
  bytes: number;
  parts: number;
  encoding: Encoding;
  sha: string;
  schemaVersion: number;
  people: number;
  entries: number;
  /** Kept whatever its age: a person chose the other copy over this one. */
  pinned?: boolean;
};

export type Head = {
  /** Changes only when the cloud copy is made anew. */
  lineage: string;
  rev: number;
  versionId: string;
  /** Server time of the last save. */
  updatedAt: string;
  versions: Version[];
};

/** A save that must follow `after`. All of it is kept, or nothing. */
export type Save = { after: { lineage: string; rev: number } | null; head: Omit<Head, "updatedAt">; add: { version: Version; bytes: Uint8Array<ArrayBuffer> }; drop: Version[] };

export interface CloudPort {
  head(): Promise<Head | null>;
  read(v: Version): Promise<Uint8Array<ArrayBuffer>>;
  /** Throws CloudError("cloud_moved") when the cloud no longer is where the save says. */
  save(s: Save): Promise<void>;
  deleteAll(): Promise<void>;
}

export class CloudError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = "CloudError";
    this.code = code;
  }
}

export const PART_BYTES = 900_000;
/** One Firestore transaction holds at most 10 MiB; the margin is for the head and the names. */
export const MAX_BYTES = 8_500_000;

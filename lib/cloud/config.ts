// Public identification of the Firebase project; none of it is secret (firestore.rules protect the
// data). Without it the app has no accounts and stays fully local.
import type { CloudConfig } from "./firebase.ts";

const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

export const cloudConfig: CloudConfig | null =
  apiKey && projectId
    ? {
        apiKey,
        projectId,
        authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
        appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
        // Development only (.env.development): the emulators on this computer.
        emulator: process.env.NEXT_PUBLIC_FIREBASE_EMULATOR === "1" ? { host: "127.0.0.1", auth: 9299, firestore: 8285 } : undefined,
      }
    : null;

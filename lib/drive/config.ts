// The Google Drive copy is offered only when the app knows its Google client (public, not a
// secret: Google checks the web address it is used from). In development only, a fake Drive in
// this browser's storage stands in for Google (.env.development: NEXT_PUBLIC_DRIVE_FAKE=1); a
// production build cannot turn it on.
export const driveClientId: string | null = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || null;

export const driveFake: boolean = process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_DRIVE_FAKE === "1";

export const driveAvailable = !!driveClientId || driveFake;

"use client";
import { useEffect } from "react";
import { keepOfflineCopy } from "@/lib/ui/offline";

/** Registers the offline service worker in production builds only. */
export function Registrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    keepOfflineCopy(navigator.serviceWorker, {
      later: (run, ms) => void setTimeout(run, ms),
      onWake: (run) => {
        window.addEventListener("online", run);
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) run();
        });
      },
    });
  }, []);
  return null;
}

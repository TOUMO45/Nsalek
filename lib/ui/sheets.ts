"use client";
import { createContext, useContext } from "react";
import type { Direction } from "../core/types.ts";

export type SheetSpec =
  | { kind: "debt"; direction?: Direction; partyId?: string; noteId?: string; prefill?: { name?: string; amount?: string; description?: string; date?: string } }
  | { kind: "payment"; direction?: Direction; partyId?: string; currency?: string }
  | { kind: "party"; partyId?: string }
  | { kind: "adjust"; obligationId: string }
  | { kind: "void"; obligationId: string }
  | { kind: "replace"; obligationId: string }
  | { kind: "reverse"; paymentId: string }
  | { kind: "installments"; obligationId: string }
  | { kind: "dates"; obligationId: string }
  | { kind: "promise"; partyId: string }
  | { kind: "remind"; partyId: string }
  | { kind: "netting"; partyId: string; currency: string }
  | { kind: "merge"; partyId: string }
  | { kind: "snooze"; partyId: string }
  | { kind: "applyAdvance"; paymentId: string };

export const SheetContext = createContext<(s: SheetSpec | null) => void>(() => {});
export const useSheet = () => useContext(SheetContext);

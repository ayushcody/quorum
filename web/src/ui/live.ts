import { useCallback, useEffect, useRef, useState } from "react";
import type { Failure } from "./pledge.ts";

// Fetch helpers for the member pages. Errors come back as a Failure (code / status / network) so
// pledge.ts can word them; nothing here knows what the words are.

export class ApiError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.code ?? (failure.network ? "network" : `HTTP ${failure.status}`));
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch {
    throw new ApiError({ network: true });
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: unknown };
  if (!res.ok) throw new ApiError({ status: res.status, ...(typeof body.error === "string" ? { code: body.error } : {}) });
  return body;
}

export const failureOf = (e: unknown): Failure => (e instanceof ApiError ? e.failure : { network: true });

// Poll a read endpoint while the tab is visible; refresh at once when it comes back or goes online.
// A failed poll keeps the last good data and marks it stale, so a blip doesn't blank the page.
export function usePolling<T>(path: string, intervalMs: number): { data?: T; failure?: Failure; stale: boolean } {
  const [state, setState] = useState<{ data?: T; failure?: Failure; stale: boolean }>({ stale: false });
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await api<T>(path);
      setState({ data, stale: false });
    } catch (e) {
      setState((s) => ({ ...s, failure: failureOf(e), stale: s.data !== undefined }));
    } finally {
      inFlight.current = false;
    }
  }, [path]);

  useEffect(() => {
    void load();
    const id = setInterval(() => document.visibilityState === "visible" && void load(), intervalMs);
    const wake = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  }, [load, intervalMs]);

  return state;
}

export type RoundSummary = {
  id: string;
  title: string;
  unit: string;
  targetQty: number;
  minMembers: number;
  status: string;
  pledgeDeadlineAt: string;
  deliveryBy: string;
  isDemo: boolean;
  progress: { pledgedQty: number; members: number };
};

export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

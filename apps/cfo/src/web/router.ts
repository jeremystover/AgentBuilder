// Tiny hash-based router. window.location.hash drives a string route id;
// useRoute subscribes to changes. Avoids react-router as a dep — we have
// 8 routes total and zero dynamic params.

import { useEffect, useState } from "react";

export type RouteId =
  | "chat"
  | "review"
  | "accounts"
  | "transactions"
  | "reports"
  | "imports"
  | "rules"
  | "budget";

const ROUTE_BY_HASH: Record<string, RouteId> = {
  "": "chat",
  "#/": "chat",
  "#/chat": "chat",
  "#/review": "review",
  "#/accounts": "accounts",
  "#/transactions": "transactions",
  "#/reports": "reports",
  "#/imports": "imports",
  "#/rules": "rules",
  "#/budget": "budget",
};

export function parseRoute(hash: string): RouteId {
  return ROUTE_BY_HASH[hash] ?? "chat";
}

export function useRoute(): [RouteId, (next: RouteId) => void] {
  const [route, setRoute] = useState<RouteId>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = (next: RouteId) => {
    window.location.hash = next === "chat" ? "#/" : `#/${next}`;
  };
  return [route, navigate];
}

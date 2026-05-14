// Hash-based router. window.location.hash drives the route id; useRoute
// subscribes to changes. Avoids react-router as a dep.

import { useEffect, useState } from "react";

export type RouteId =
  | "gather"
  | "review"
  | "transactions"
  | "reporting"
  | "planning"
  | "spending"
  | "scenarios"
  | "settings";

const ROUTE_BY_HASH: Record<string, RouteId> = {
  "":              "gather",
  "#/":            "gather",
  "#/gather":      "gather",
  "#/review":      "review",
  "#/transactions": "transactions",
  "#/reporting":   "reporting",
  "#/planning":    "planning",
  "#/spending":    "spending",
  "#/scenarios":   "scenarios",
  "#/settings":    "settings",
};

export function parseRoute(hash: string): RouteId {
  return ROUTE_BY_HASH[hash] ?? "gather";
}

export function useRoute(): [RouteId, (next: RouteId) => void] {
  const [route, setRoute] = useState<RouteId>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = (next: RouteId) => {
    window.location.hash = `#/${next}`;
  };
  return [route, navigate];
}

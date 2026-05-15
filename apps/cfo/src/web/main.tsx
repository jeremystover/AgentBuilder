import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./App";
import "./index.css";

// Report uncaught browser errors to the backend (fleet_errors / bug_tickets).
function reportClientError(message: string, stack?: string) {
  try {
    const payload = JSON.stringify({ message, stack, url: location.href });
    navigator.sendBeacon(
      "/api/v1/client-error",
      new Blob([payload], { type: "application/json" }),
    );
  } catch {
    // best effort — never let error reporting throw
  }
}
window.addEventListener("error", (e) => reportClientError(e.message, e.error?.stack));
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { message?: string; stack?: string } | undefined;
  reportClientError(String(reason?.message ?? e.reason), reason?.stack);
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
    <Toaster position="bottom-right" richColors closeButton />
  </React.StrictMode>,
);

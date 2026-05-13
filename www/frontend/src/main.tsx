import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { App } from "./App";
import { registerSW } from "virtual:pwa-register";
import { toast } from "sonner";
import "./index.css";

console.info(
  `%cMyNotes Frontend%c v${import.meta.env.VITE_BUILD_SHA ?? "dev"}`,
  "font-weight:bold",
  "font-weight:normal",
);

registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    // Alle 60 Min auf neue SW-Version prüfen
    setInterval(() => reg.update(), 60 * 60 * 1000);
    // Beim Zurückwechseln zur App sofort prüfen
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update();
    });
  },
  onNeedRefresh() {
    toast("Neue Version verfügbar", {
      action: { label: "Aktualisieren", onClick: () => location.reload() },
      duration: Infinity,
    });
  },
});

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
        <Toaster position="top-right" />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);

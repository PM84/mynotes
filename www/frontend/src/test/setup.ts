import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

// PWA virtuelles Modul stubben.
import { vi } from "vitest";
vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: () => ({ needRefresh: [false], updateServiceWorker: () => {} }),
}));

// localStorage in jsdom existiert; nichts zu tun.

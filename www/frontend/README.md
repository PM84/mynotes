# MyNotes Frontend

PWA-Frontend (React 19 + Vite + Workbox + Dexie + Excalidraw).

## Entwicklung

Das gesamte Setup läuft über Docker:

```sh
cd ../..
bindev/start.sh
```

Frontend-Dev-Server läuft dann unter https://mynotes.localhost (HMR via Vite).

## Architektur

- `src/api.ts` – fetch-Wrapper mit JWT
- `src/auth.ts` – Zustand-Store für Tokens (localStorage)
- `src/db.ts` – Dexie/IndexedDB-Schema (notes, assets, pending)
- `src/sync.ts` – Offline-First-CRUD + Background-Sync-Queue
- `src/views/*` – Login, Notes-Liste, Editor, KI-Suche, Admin
- `vite.config.ts` – PWA-Config mit Workbox-Runtime-Caching

## Hinweise

- Excalidraw und PDF.js werden lazy geladen.
- Asset-Uploads werden offline in IndexedDB gespeichert und nach Reconnect hochgeladen.
- KI-Endpunkte (RAG, Vision) sind ausschließlich online verfügbar.

# Developer Guide

- Static site: no build step. Serve with any static server.
- `app.js` passes `node --check` on this snapshot.
- The C++ plugin: `cmake -S plugin -B build && cmake --build build --config Release` (README). Not built in this pass.
- `docs/TESTING.md` describes npm, Vite and Playwright commands that are not present in this tree. Reconcile it before relying on it.

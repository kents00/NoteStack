# NoteStack — Frontend

> React + TypeScript + Vite frontend for the NoteStack AI document workspace.

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-build%20tool-646CFF?logo=vite&logoColor=white)](https://vitejs.dev/)

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Project Layout](#project-layout)
4. [Prerequisites](#prerequisites)
5. [Setup](#setup)
6. [Configuration](#configuration)
7. [Available Scripts](#available-scripts)
8. [Key Components](#key-components)
9. [SSE Citation Streaming](#sse-citation-streaming)
10. [Troubleshooting](#troubleshooting)

---

## Overview

The NoteStack frontend is a **React 19** single-page application that provides:

- **Authentication** — register and login with JWT-backed sessions.
- **Document workspace** — upload, organize into folders, and monitor ingestion status.
- **Citation-aware chat** — streaming responses with clickable inline source citations.
- **Notes panel** — save, edit, and delete notes from any assistant response.
- **Model settings** — configure cloud providers (Gemini, OpenAI, OpenRouter, Anthropic, Cerebras) or local runtimes (Ollama, LM Studio) from within the app.

The frontend communicates with the **NoteStack backend** at `http://localhost:8000/api` via REST and SSE streaming.

---

## Tech Stack

| Package | Role |
|---|---|
| React 19 | UI framework |
| TypeScript 5 | Type safety |
| Vite | Build tool and dev server |
| Tailwind CSS (`@tailwindcss/vite`) | Utility-first styling |
| `motion/react` | Animations and transitions |
| `react-markdown` + `remark-gfm` + `rehype-sanitize` | Markdown rendering with safe HTML |

---

## Project Layout

```text
frontend/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── metadata.json
└── src/
    ├── App.tsx                         # Root component, routing, auth gate
    ├── main.tsx                        # React entry point
    ├── index.css                       # Global styles
    ├── vite-env.d.ts
    ├── components/
    │   ├── LandingPage.tsx             # Marketing / entry page
    │   ├── AuthPages.tsx               # Login and register pages
    │   ├── workspace/                  # Main workspace (chat, sidebar, notes, settings)
    │   └── notifications/
    │       ├── NotificationHosts.tsx
    │       ├── NotificationInline.tsx
    │       ├── NotificationModal.tsx
    │       └── NotificationToastHost.tsx
    ├── context/
    │   └── NotificationContext.tsx     # Global notification state and helpers
    ├── services/
    │   └── api.ts                      # Typed API client (base: http://localhost:8000/api)
    └── utils/
        ├── citationStream.ts           # SSE parser, citation delta merging
        ├── citationStream.test.ts
        ├── authNotifications.ts        # Auth-aware notification helpers
        └── authNotifications.test.ts
```

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | 18+ | `node --version` |
| npm | bundled with Node | `npm --version` |

The **NoteStack backend** must be running on `http://localhost:8000` before the frontend can do anything meaningful.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server
npm run dev
```

The app will be available at **`http://localhost:3000`**.

> **Windows PowerShell tip:** If `npm run` is blocked by execution policy, use `npm.cmd run <script>` instead.

---

## Configuration

| Setting | Location | Notes |
|---|---|---|
| API base URL | `src/services/api.ts` | Hardcoded to `http://localhost:8000/api` — change before deploying |
| Cloud API keys | Browser `localStorage` | User-entered in the in-app Settings panel |
| Model selections | Browser `localStorage` | Persisted per session |
| `GEMINI_API_KEY` env | `vite.config.ts` | Legacy support; runtime settings panel is preferred |

To point the frontend at a different backend (e.g., a deployed API), update the base URL in `src/services/api.ts`:

```ts
const BASE_URL = "https://your-backend-domain.com/api";
```

---

## Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server on `http://localhost:3000` with hot reload |
| `npm run build` | Production build output to `dist/` |
| `npm run lint` | Run ESLint across all source files |
| `npm run test` | Run unit tests (Vitest) |

---

## Key Components

### `src/services/api.ts`

Typed API client wrapping all backend endpoints. Every feature area (auth, documents, folders, chat, notes, model management) has a corresponding set of functions here. Import from this module rather than calling `fetch` directly.

### `src/utils/citationStream.ts`

SSE response parser. Handles:

- Splitting raw SSE text into typed frames.
- Merging incremental `[CITATIONS_DELTA]` payloads.
- Normalizing `[N]` markdown citation markers into rich citation objects.
- Finalization on `[CITATIONS]` and `[DONE]` frames.

### `src/context/NotificationContext.tsx`

Global notification system. Provides `toast`, `inline`, and `modal` notification helpers consumed anywhere in the component tree.

### `src/components/workspace/`

Main application shell after login. Contains:

- **Chat interface** — message list, SSE streaming, citation rendering.
- **Sidebar** — document list, folder tree, source selection.
- **Notes panel** — saved notes from chat output.
- **Settings panel** — provider and model configuration.

---

## SSE Citation Streaming

The chat endpoint (`POST /api/chat/`) streams SSE frames. The frontend handles the following frame types:

| Frame prefix | Action |
|---|---|
| *(plain text)* | Appended to the message buffer |
| `[CITATIONS_DELTA] ` | Merged into the live citation state |
| `[CITATIONS] ` | Replaces citation state with the final snapshot |
| `[STREAM_ERROR] ` | Displays an error notification |
| `[DONE]` | Finalizes the message and persists it to the backend |

See `src/utils/citationStream.ts` for the full parsing logic.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **Cannot reach backend** | Confirm backend is running at `http://localhost:8000`. Check for CORS errors in the browser console. |
| **Login succeeds but requests return 403** | Clear `localStorage` (`localStorage.clear()` in DevTools console) and sign in again. |
| **Empty streaming response** | Check the notification panel for `[STREAM_ERROR]` details. Try a different model or provider. |
| **PowerShell execution policy error** | Use `npm.cmd run <script>` instead of `npm run <script>`. |
| **Document uploaded but model ignores it** | Select the document in the Sources panel. Wait for status `PROCESSED` before querying. |

---

*Full project documentation → [`../README.md`](../README.md) · Quick start → [`../QUICKSTART.md`](../QUICKSTART.md)*

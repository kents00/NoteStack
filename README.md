# NoteStack — Backend

> FastAPI + PostgreSQL + ChromaDB backend for the NoteStack AI document workspace.

[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110%2B-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![ChromaDB](https://img.shields.io/badge/ChromaDB-vector%20store-orange)](https://www.trychroma.com/)
[![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Project Layout](#project-layout)
4. [Prerequisites](#prerequisites)
5. [Setup](#setup)
6. [Configuration](#configuration)
7. [Running the Server](#running-the-server)
8. [API Reference](#api-reference)
9. [RAG Pipeline](#rag-pipeline)
10. [Testing](#testing)
11. [Troubleshooting](#troubleshooting)

---

## Overview

The NoteStack backend is a **FastAPI** application that provides:

- **JWT authentication** — register, login, and bearer-token-protected routes.
- **Document ingestion** — async pipeline for PDF, DOCX, PPTX, and plaintext files.
- **Vector search** — ChromaDB-backed semantic retrieval using local `all-MiniLM-L6-v2` embeddings.
- **Citation-aware SSE streaming** — structured `[CITATIONS_DELTA]` / `[CITATIONS]` / `[DONE]` events.
- **Multi-provider LLM routing** — Gemini, OpenAI, OpenRouter, Anthropic, Cerebras, and any OpenAI-compatible endpoint.
- **Notes and folders** — CRUD workspace for organizing documents and saving chat output.

---

## Tech Stack

| Package | Role |
|---|---|
| FastAPI | Async HTTP framework + OpenAPI docs |
| SQLAlchemy | ORM and schema management |
| Pydantic v2 + pydantic-settings | Data validation and settings |
| PostgreSQL + psycopg2 | Relational persistence |
| LangChain integrations | Document loaders and text splitters |
| ChromaDB | Vector store for embedded chunks |
| `sentence-transformers` `all-MiniLM-L6-v2` | Local HuggingFace embeddings |
| PyMuPDF / python-docx | PDF and DOCX text extraction |

---

## Project Layout

```text
backend/
├── Dockerfile
├── requirements.txt
├── .env                    # Local environment variables (do not commit)
├── .gitignore
├── .dockerignore
├── app/
│   ├── main.py             # FastAPI app factory and startup hooks
│   ├── api/
│   │   ├── deps.py         # Auth dependency injection (get_current_user)
│   │   ├── main.py         # Router registration
│   │   └── routes/
│   │       ├── auth.py
│   │       ├── users.py
│   │       ├── documents.py
│   │       ├── folders.py
│   │       ├── chat.py     # SSE streaming, provider routing, discovery
│   │       └── notes.py
│   ├── core/
│   │   ├── config.py       # Pydantic settings — reads from .env
│   │   ├── security.py     # Password hashing, JWT creation and validation
│   │   └── storage.py      # Upload file handling
│   ├── db/
│   │   └── database.py     # SQLAlchemy engine, session factory, schema compat
│   ├── models/             # SQLAlchemy ORM models
│   │   ├── user.py
│   │   ├── document.py
│   │   ├── folder.py
│   │   ├── chat_session.py
│   │   ├── chat_message.py
│   │   └── note.py
│   ├── schemas/            # Pydantic request/response schemas
│   │   ├── user.py
│   │   ├── document.py
│   │   ├── folder.py
│   │   ├── chat.py
│   │   ├── note.py
│   │   └── token.py
│   └── services/
│       ├── rag.py          # RAG pipeline, retrieval, citation construction
│       ├── ingestion.py    # Background ingestion task
│       └── extractor.py    # MIME-type text extraction
└── tests/
    └── test_rag_citations.py
```

---

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Python | 3.10+ (3.11 recommended) | `python --version` |
| PostgreSQL | 15+ | Only needed without Docker |
| Docker Desktop + Compose | latest | Recommended path |

---

## Setup

### Option A — Docker (Recommended)

From the **repository root** (not this folder):

```bash
docker compose up --build
```

The `backend` service starts on **`http://localhost:8000`**.

> **First run:** Downloads the `all-MiniLM-L6-v2` embedding model (~90 MB). Subsequent starts are fast.

### Option B — Local (No Docker)

**1. Create a PostgreSQL database:**

```sql
CREATE DATABASE notestack;
CREATE USER postgres WITH PASSWORD 'password';
GRANT ALL PRIVILEGES ON DATABASE notestack TO postgres;
```

**2. Create `backend/.env`** (see [Configuration](#configuration) below).

**3. Create and activate a virtual environment:**

```bash
python -m venv .venv

# Windows PowerShell
.\.venv\Scripts\Activate.ps1

# macOS / Linux
source .venv/bin/activate
```

**4. Install dependencies:**

```bash
pip install -r requirements.txt
```

**5. Start the server:**

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Wait for `Application startup complete.` in the console.

---

## Configuration

Create a `.env` file in this directory (`backend/.env`):

### Required

| Variable | Purpose | Example |
|---|---|---|
| `PROJECT_NAME` | FastAPI app title | `NoteStack API` |
| `DATABASE_URL` | SQLAlchemy connection string | `postgresql://postgres:password@localhost:5432/notestack` |
| `SECRET_KEY` | JWT signing secret — **change in production** | `replace-with-long-random-secret` |
| `ALGORITHM` | JWT algorithm | `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Token lifespan in minutes | `10080` (7 days) |

Generate a strong secret key:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### Optional — Cloud model defaults

| Variable | Used for | Default |
|---|---|---|
| `GEMINI_MODEL` | Gemini primary default | `gemini-2.0-flash` |
| `OPENAI_MODEL` | OpenAI model fallback | `gpt-4o-mini` |
| `OPENROUTER_MODEL` | OpenRouter model fallback | `openrouter/auto` |
| `ANTHROPIC_MODEL` | Anthropic model fallback | `claude-3-haiku-20240307` |
| `CEREBRAS_MODEL` | Cerebras model fallback | `llama-3.3-70b` |
| `OPENAI_COMPATIBLE_MODEL` | OpenAI-compatible cloud default | `gpt-4o-mini` |
| `OPENAI_COMPATIBLE_BASE_URL` | OpenAI-compatible API base URL | empty |

### Optional — Local runtime

| Variable | Purpose | Default |
|---|---|---|
| `LOCAL_MODEL_URL` | Default local endpoint URL | empty |
| `LOCAL_MODEL_NAME` | Default local model name | empty |
| `LOCAL_MODEL_CONTEXT_LENGTH` | Context length hint | `4096` |
| `LOCAL_PROMPT_MAX_TOKENS` | Hard token budget override | if set, used directly |
| `LOCAL_PROMPT_TOKEN_MARGIN` | Reserved margin for output tokens | `256` |

---

## Running the Server

| Command | Description |
|---|---|
| `uvicorn app.main:app --reload` | Start dev server with hot reload |
| `uvicorn app.main:app --host 0.0.0.0 --port 8000` | Production-style start |
| `docker compose up --build` | Start via Docker (from repo root) |

| URL | Description |
|---|---|
| `http://localhost:8000` | FastAPI root |
| `http://localhost:8000/docs` | Swagger UI (interactive API docs) |
| `http://localhost:8000/api/openapi.json` | OpenAPI JSON schema |

---

## API Reference

**Base URL:** `http://localhost:8000/api`

**Auth:** `POST /auth/login` returns a bearer token. Include `Authorization: Bearer <token>` on all protected endpoints.

### Auth and Users

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/register` | Register a new user |
| `POST` | `/auth/login` | Login (OAuth2 form — `username` = email) |
| `GET` | `/users/me` | Get current authenticated user |
| `PUT` | `/users/me` | Update profile or password |

### Documents and Folders

| Method | Path | Description |
|---|---|---|
| `POST` | `/documents/upload` | Upload a file and start background ingestion |
| `GET` | `/documents/` | List all documents for the current user |
| `PUT` | `/documents/{document_id}` | Rename or move a document |
| `DELETE` | `/documents/{document_id}` | Delete a document |
| `GET` | `/folders/` | List all folders |
| `POST` | `/folders/` | Create a folder |
| `PUT` | `/folders/{folder_id}` | Rename a folder |
| `DELETE` | `/folders/{folder_id}` | Delete a folder (documents are detached, not deleted) |

### Notes

| Method | Path | Description |
|---|---|---|
| `GET` | `/notes/` | List all notes for the current user |
| `POST` | `/notes/` | Create or upsert a note |
| `PUT` | `/notes/{note_id}` | Update a note |
| `DELETE` | `/notes/{note_id}` | Delete a note |

### Chat and Model Management

| Method | Path | Description |
|---|---|---|
| `POST` | `/chat/` | Stream a chat response via SSE |
| `GET` | `/chat/sessions` | List all chat sessions |
| `POST` | `/chat/sessions` | Create a new chat session |
| `DELETE` | `/chat/sessions` | Delete all sessions for the current user |
| `DELETE` | `/chat/sessions/{session_id}` | Delete a single session |
| `GET` | `/chat/sessions/{session_id}/messages` | List messages in a session |
| `POST` | `/chat/sessions/{session_id}/messages` | Persist a message to a session |
| `PATCH` | `/chat/messages/{message_id}/feedback` | Save like/dislike feedback |
| `POST` | `/chat/cloud/validate` | Validate a cloud API key and discover models |
| `GET` | `/chat/local/discover` | Detect local runtime endpoint and model list |
| `GET` | `/chat/health` | Proxy local runtime health check |

### SSE Event Contract

The `POST /chat/` endpoint emits standard SSE `data:` frames:

| Frame prefix | Meaning |
|---|---|
| *(plain text)* | Assistant token — append to message buffer |
| `[CITATIONS_DELTA] ` | Incremental citation update during streaming |
| `[CITATIONS] ` | Final citation snapshot |
| `[CITATIONS_PARTIAL] ` | Partial state on mid-stream failure |
| `[STREAM_ERROR] ` | Structured error payload |
| `[DONE]` | Terminal frame — stream complete |

---

## RAG Pipeline

### Ingestion workflow

```text
1. File saved to uploads/
2. Document row created → status: UPLOADED
3. Background task begins → status: PROCESSING
4. Text extracted by MIME type:
     PDF   → PyMuPDF
     DOCX  → python-docx
     PPTX  → slide XML extraction
     other → plaintext fallback
5. Text chunked (chunk_size=1000, chunk_overlap=100)
6. Chunks embedded using all-MiniLM-L6-v2 (local HuggingFace model)
7. Vectors + metadata written to ChromaDB (collection: notestack_docs)
8. Document status → PROCESSED  (or ERROR on failure)
```

### Retrieval strategy

| Scenario | Strategy |
|---|---|
| **Single document** | Similarity search, `k=5` top chunks |
| **Multiple documents** | Balanced retrieval: `target_total = max(6, min(12, doc_count × 2))`, interleaved and deduplicated |

### Storage locations

| Data | Docker volume | Local path |
|---|---|---|
| PostgreSQL data | `postgres_data` | Local Postgres data dir |
| Uploaded files | `local_uploads` | `backend/uploads/` |
| Chroma vectors | `chroma_data` | `backend/chroma_data/` |

---

## Testing

```bash
# Full test suite
pytest

# Citation regression tests only
pytest tests/test_rag_citations.py
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `cannot connect to database` | Confirm PostgreSQL is running on port `5432`. Check `DATABASE_URL` in `.env`. |
| `403` after login | Clear browser `localStorage`. Verify `SECRET_KEY` has not changed between restarts. |
| Document stuck at `PROCESSING` | Check server logs for extraction or embedding errors. |
| Local runtime not detected | Use `http://host.docker.internal:<port>` if backend is in Docker instead of `localhost`. |
| Docker: backend can't reach DB | Run `docker compose logs db`. Try `docker compose down -v && docker compose up --build`. |

---

*Full project documentation → [`../README.md`](../README.md) · Quick start → [`../QUICKSTART.md`](../QUICKSTART.md)*

# AI Study Lab

A TypeScript React + Node application for generating structured, research-backed learning experiences with a private local Ollama model and Tavily web research.

## What is implemented

- Responsive dashboard, explore, create, modules, progress, tutor, flashcards, study plans, and settings views.
- Real background generation jobs with visible stage progress.
- Configurable Ollama health, model discovery, and JSON generation.
- Optional Tavily research with graceful local-AI fallback when Tavily is not configured.
- Validated module output before it is stored or returned to the client.
- PostgreSQL persistence with idempotent startup migrations; JSON state remains as a fallback when `DATABASE_URL` is not set.

## Requirements

- Node.js 20+
- Ollama running locally for module generation
- Optional Tavily API key for current web research

## Setup

```bash
npm install
cp .env.example .env
ollama serve
ollama pull qwen3.5:4b
npm run dev
```

The app is served at `http://localhost:5000` in development.

## Environment

| Variable | Description |
| --- | --- |
| `PORT` | Web server port, defaults to `5000` |
| `OLLAMA_BASE_URL` | Private Ollama HTTP API URL |
| `DEFAULT_MODEL` | Default model, `qwen3.5:4b` |
| `TAVILY_API_KEY` | Optional server-only Tavily key |
| `TAVILY_DEPTH` | `basic`, `advanced`, or `deep` |
| `DATABASE_URL` | PostgreSQL connection string used by the server |

## Architecture

The browser only talks to the Node API through relative URLs. The server owns Ollama and Tavily credentials, runs the staged job pipeline, validates structured JSON, and persists modules, chapters, objectives, sources, and generation jobs to PostgreSQL when `DATABASE_URL` is configured. On every `npm start` or `npm run dev`, the server applies missing idempotent schema migrations before opening the configured port. Ollama is never exposed through the public client.

### PostgreSQL startup behavior

Set `DATABASE_URL` in `.env` to your local PostgreSQL database:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/ai_study_lab
```

The database and PostgreSQL user must already exist. The app creates its own tables automatically on startup. Creating a study module then inserts its module row plus chapter, objective, source, and generation-job rows. If the database is empty and the old `data/state.json` contains data, the app imports that data once.

## Cloudflare Tunnel

Expose only the web app port through a tunnel:

```bash
cloudflared tunnel --url http://localhost:5000
```

Do not expose `localhost:11434` directly. Keep Ollama bound to the private machine/network and let the Node API call it.

## Troubleshooting

- If the settings page says Ollama is unavailable, start it with `ollama serve` and verify the configured URL.
- If Tavily is unavailable, generation can continue using local AI knowledge, but sources will be marked as unavailable.
- If generation fails, inspect the job status in the UI and server logs; raw stack traces are not returned to the browser.
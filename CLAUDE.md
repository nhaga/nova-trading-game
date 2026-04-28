# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A real-time multiplayer trading simulation game for teaching algorithmic trading concepts. Players connect via WebSocket, receive live price feeds driven by a Geometric Brownian Motion model, and place buy/sell orders. An admin panel controls game state and price parameters.

**Stack:** FastAPI (Python) backend + React/Vite/Tailwind frontend. All state is in-memory — no database.

## Running the App

**Backend:**
```bash
cd backend
source .venv/bin/activate
ADMIN_PASSWORD=admin123 uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Frontend:**
```bash
cd frontend
npm run dev
```

Frontend runs at `http://localhost:5173`. To override backend URL, set `VITE_API_BASE` in `frontend/.env.local`.

## Architecture

### Backend (`backend/app/main.py`)

Single-file FastAPI app (~309 lines). Key pieces:

- **`GameState`** — singleton holding all in-memory state: WebSocket connections, user portfolios, current price, running flag, and GBM parameters.
- **`UserState`** — per-player: username, cash ($1000 starting), position, trade history.
- **`/ws` WebSocket endpoint** — handles player connections. On connect, assigns sequential username (`user1`, `user2`, …). Receives `{"action": "trade", "side": "buy"|"sell"}` messages.
- **Price loop** — `asyncio` background task; ticks every `tick_interval` seconds, updates price via `price *= (1 + gauss(drift, volatility))`, broadcasts `market` event to all connected clients.
- **Admin HTTP endpoints** (`POST /admin/login`, `/admin/start`, `/admin/stop`, `/admin/params`, `GET /admin/trades`, `GET /admin/users`) — token-authenticated. Stop resets all user balances.
- **`asyncio.Lock`** protects `GameState` from concurrent mutation.

GBM defaults: `tick_interval=1s`, `volatility=0.008`, `drift=0.0005`. Fixed trade size: `FIXED_TRADE_QTY = 100` units (backend). Each $0.01 price move = $1 PnL per unit held.

### Frontend (`frontend/src/App.jsx`)

Single React component (~462 lines) managing:
- WebSocket connection to `/ws`
- Price series buffer (140 ticks) for SVG chart with buy/sell markers
- Portfolio display (cash, position, equity)
- Live event feed (14 items)
- Admin panel: login → start/stop game, adjust GBM params, view trade history

Custom Tailwind colors: `surface` (#f4f1ea), `ink` (#12262f), `accent` (#d45c2a, price line), `positive` (#147a4f, buy), `negative` (#9f2f2f, sell).

## Known Issues

- **Trade quantity mismatch**: Frontend displays "1000 units" but backend executes trades as 100 units (`FIXED_TRADE_QTY = 100`).
- **No persistence**: Server restart wipes all game state.

# Trading Game (FastAPI + React + Tailwind)

A full-stack trading game with:

- FastAPI backend
- WebSocket market stream
- Sequential usernames on connect (`user1`, `user2`, ...)
- Buy / Sell (including short sell)
- Admin password login
- Admin controls for start/stop/reset and price model params
- Admin dashboard for all user trades

## Project Structure

- `backend/` FastAPI service
- `frontend/` React + Tailwind client

## Backend Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export ADMIN_PASSWORD="admin123"
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

API base URL: `http://localhost:8000`

### Important Backend Endpoints

- `GET /health`
- `POST /admin/login` with body `{ "password": "..." }`
- `POST /admin/start?token=...`
- `POST /admin/stop?token=...`
- `POST /admin/params?token=...`
- `GET /admin/trades?token=...`
- `WebSocket /ws`

## Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

Optional: set backend URL with env var:

```bash
# frontend/.env.local
VITE_API_BASE=http://localhost:8000
```

## Gameplay Notes

- Each connected player gets a sequential username.
- All users start with `$1000` cash.
- Trade quantity is fixed at `1000` units per order.
- With fixed size, a `$0.01` price move equals `$10` PnL per open trade unit.
- When admin stops the game, every user resets to:
  - cash: `$1000`
  - position: `0`
  - trade history: cleared
- Price follows a simple stochastic process controlled by:
  - `tick_interval`
  - `volatility`
  - `drift`

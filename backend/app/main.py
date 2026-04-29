import asyncio
import os
import random
import secrets
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

STARTING_CASH = 1000.0
FIXED_TRADE_QTY = 100.0


@dataclass
class UserState:
    username: str
    cash: float = STARTING_CASH
    position: float = 0.0
    trades: list[dict[str, Any]] = field(default_factory=list)

    def equity(self, mark_price: float) -> float:
        return self.cash + (self.position * mark_price)


class AdminLoginRequest(BaseModel):
    password: str


class AdminLoginResponse(BaseModel):
    token: str


class ParamsUpdateRequest(BaseModel):
    tick_interval: float = Field(default=1.0, ge=0.1, le=10.0)
    volatility: float = Field(default=0.008, ge=0.0, le=0.2)
    drift: float = Field(default=0.0005, ge=-0.1, le=0.1)
    model: str = Field(default="random_walk")
    # Stochastic drift (Ornstein-Uhlenbeck on drift)
    drift_volatility: float = Field(default=0.001, ge=0.0, le=0.05)
    drift_mean_reversion: float = Field(default=0.1, ge=0.0, le=1.0)
    # Jump diffusion (Merton)
    jump_intensity: float = Field(default=0.05, ge=0.0, le=1.0)
    jump_mean: float = Field(default=0.0, ge=-0.5, le=0.5)
    jump_std: float = Field(default=0.03, ge=0.0, le=0.5)


class StartRequest(BaseModel):
    duration: int = Field(default=300, ge=10, le=7200)


class StartStopResponse(BaseModel):
    running: bool


class GameState:
    def __init__(self) -> None:
        self.connections: dict[str, WebSocket] = {}
        self.users: dict[str, UserState] = {}
        self.username_counter = 0
        self.price = 100.0
        self.symbol = "Nova Coin"
        self.running = False
        self.trades: list[dict[str, Any]] = []
        self.params = {
            "tick_interval": 1.0,
            "volatility": 0.008,
            "drift": 0.0005,
            "model": "random_walk",
            "drift_volatility": 0.001,
            "drift_mean_reversion": 0.1,
            "jump_intensity": 0.05,
            "jump_mean": 0.0,
            "jump_std": 0.03,
        }
        self.current_drift: float = 0.0005
        self.admin_token: str | None = None
        self.lock = asyncio.Lock()
        self._timer_task: asyncio.Task | None = None

    async def register(self, websocket: WebSocket) -> str:
        await websocket.accept()
        async with self.lock:
            self.username_counter += 1
            username = f"user{self.username_counter}"
            self.connections[username] = websocket
            self.users[username] = UserState(username=username)
        await websocket.send_json(
            {
                "type": "welcome",
                "username": username,
                "price": round(self.price, 2),
                "symbol": self.symbol,
                "running": self.running,
                "fixed_trade_qty": FIXED_TRADE_QTY,
                "portfolio": self._portfolio_payload(username),
            }
        )
        await self.broadcast_market()
        return username

    async def unregister(self, username: str) -> None:
        async with self.lock:
            self.connections.pop(username, None)

    def _portfolio_payload(self, username: str) -> dict[str, Any]:
        user = self.users[username]
        return {
            "cash": round(user.cash, 2),
            "position": round(user.position, 4),
            "equity": round(user.equity(self.price), 2),
        }

    async def place_trade(self, username: str, side: str) -> dict[str, Any]:
        if not self.running:
            raise HTTPException(status_code=400, detail="Game is not running")
        if side not in {"buy", "sell"}:
            raise HTTPException(status_code=400, detail="Side must be 'buy' or 'sell'")

        async with self.lock:
            user = self.users[username]
            qty = FIXED_TRADE_QTY
            if side == "buy" and user.position + qty > FIXED_TRADE_QTY:
                raise HTTPException(status_code=400, detail="Position limit reached: already max long")
            if side == "sell" and user.position - qty < -FIXED_TRADE_QTY:
                raise HTTPException(status_code=400, detail="Position limit reached: already max short")
            trade_value = qty * self.price
            if side == "buy":
                user.cash -= trade_value
                user.position += qty
            else:
                user.cash += trade_value
                user.position -= qty

            trade = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "username": username,
                "symbol": self.symbol,
                "side": side,
                "qty": round(qty, 4),
                "price": round(self.price, 2),
                "cash_after": round(user.cash, 2),
                "position_after": round(user.position, 4),
                "equity_after": round(user.equity(self.price), 2),
            }
            user.trades.append(trade)
            self.trades.append(trade)

        await self.broadcast(
            {
                "type": "trade",
                "trade": trade,
                "portfolio": self._portfolio_payload(username),
            }
        )
        return trade

    async def broadcast(self, payload: dict[str, Any]) -> None:
        stale_users: list[str] = []
        for username, ws in self.connections.items():
            try:
                await ws.send_json(payload)
            except Exception:
                stale_users.append(username)
        for username in stale_users:
            await self.unregister(username)

    async def broadcast_market(self) -> None:
        users_payload = {
            username: self._portfolio_payload(username)
            for username in self.users.keys()
        }
        await self.broadcast(
            {
                "type": "market",
                "symbol": self.symbol,
                "price": round(self.price, 2),
                "running": self.running,
                "fixed_trade_qty": FIXED_TRADE_QTY,
                "users": users_payload,
            }
        )

    async def start(self, duration: int = 300) -> None:
        if self._timer_task and not self._timer_task.done():
            self._timer_task.cancel()
        self.running = True
        await self.broadcast(
            {"type": "admin", "message": f"Game started ({duration}s)", "running": True}
        )
        self._timer_task = asyncio.create_task(self._auto_stop(duration))

    async def _auto_stop(self, duration: int) -> None:
        await asyncio.sleep(duration)
        if self.running:
            await self.stop()

    async def stop(self) -> None:
        if self._timer_task and not self._timer_task.done():
            self._timer_task.cancel()
        self._timer_task = None
        self.running = False
        await self.broadcast(
            {
                "type": "admin",
                "message": "Game stopped",
                "running": False,
            }
        )
        await self.broadcast_market()

    async def reset(self) -> None:
        async with self.lock:
            for user in self.users.values():
                user.cash = STARTING_CASH
                user.position = 0.0
                user.trades.clear()
            self.trades.clear()
            self.price = 100.0
        self.current_drift = self.params["drift"]
        await self.broadcast(
            {
                "type": "admin",
                "message": "Balances, trade history and price reset",
                "running": self.running,
            }
        )
        await self.broadcast_market()

    async def update_params(self, params: ParamsUpdateRequest) -> None:
        self.params = params.model_dump()
        self.current_drift = params.drift
        await self.broadcast(
            {
                "type": "admin",
                "message": "Parameters updated",
                "params": self.params,
            }
        )

    def login_admin(self, password: str) -> str:
        expected = os.getenv("ADMIN_PASSWORD", "admin123")
        if password != expected:
            raise HTTPException(status_code=401, detail="Invalid password")
        token = secrets.token_urlsafe(24)
        self.admin_token = token
        return token

    def verify_admin(self, token: str) -> None:
        if not token or token != self.admin_token:
            raise HTTPException(status_code=401, detail="Unauthorized")


state = GameState()
app = FastAPI(title="Trading Game API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(price_loop())


async def price_loop() -> None:
    while True:
        await asyncio.sleep(state.params["tick_interval"])
        if state.running:
            model = state.params.get("model", "random_walk")
            if model == "stochastic_drift":
                state.current_drift += (
                    state.params["drift_mean_reversion"] * (state.params["drift"] - state.current_drift)
                    + state.params["drift_volatility"] * random.gauss(0, 1)
                )
                shock = random.gauss(state.current_drift, state.params["volatility"])
            elif model == "jump_diffusion":
                shock = random.gauss(state.params["drift"], state.params["volatility"])
                if random.random() < state.params["jump_intensity"]:
                    shock += random.gauss(state.params["jump_mean"], state.params["jump_std"])
            else:
                shock = random.gauss(state.params["drift"], state.params["volatility"])
            state.price = round(max(0.01, state.price * (1 + shock)), 2)
            await state.broadcast_market()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/admin/login", response_model=AdminLoginResponse)
async def admin_login(payload: AdminLoginRequest) -> AdminLoginResponse:
    token = state.login_admin(payload.password)
    return AdminLoginResponse(token=token)


@app.post("/admin/start", response_model=StartStopResponse)
async def admin_start(token: str, payload: StartRequest = StartRequest()) -> StartStopResponse:
    state.verify_admin(token)
    await state.start(duration=payload.duration)
    return StartStopResponse(running=state.running)


@app.post("/admin/stop", response_model=StartStopResponse)
async def admin_stop(token: str) -> StartStopResponse:
    state.verify_admin(token)
    await state.stop()
    return StartStopResponse(running=state.running)


@app.post("/admin/reset")
async def admin_reset(token: str) -> dict[str, bool]:
    state.verify_admin(token)
    await state.reset()
    return {"ok": True}


@app.post("/admin/params")
async def admin_params(token: str, payload: ParamsUpdateRequest) -> dict[str, Any]:
    state.verify_admin(token)
    await state.update_params(payload)
    return {"ok": True, "params": state.params}


@app.get("/admin/trades")
async def admin_trades(token: str) -> list[dict[str, Any]]:
    state.verify_admin(token)
    return state.trades


@app.get("/admin/users")
async def admin_users(token: str) -> dict[str, Any]:
    state.verify_admin(token)
    return {
        "users": [
            {
                **asdict(user),
                "equity": round(user.equity(state.price), 2),
                "trades": len(user.trades),
            }
            for user in state.users.values()
        ]
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    username = await state.register(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            message_type = data.get("type")
            if message_type == "trade":
                side = str(data.get("side", "")).lower()
                await state.place_trade(username=username, side=side)
            else:
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": "Unsupported message type",
                    }
                )
    except WebSocketDisconnect:
        await state.unregister(username)
    except Exception as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        await state.unregister(username)

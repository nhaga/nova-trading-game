import React, { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const WS_BASE = API_BASE.replace("http", "ws");

function toMoney(value) {
  return Number(value || 0).toFixed(2);
}

function App() {
  const [username, setUsername] = useState("connecting...");
  const [connected, setConnected] = useState(false);
  const [price, setPrice] = useState(100);
  const [symbol, setSymbol] = useState("NovaIMS Coin");
  const [running, setRunning] = useState(false);
  const [fixedTradeQty, setFixedTradeQty] = useState(1000);
  const [portfolio, setPortfolio] = useState({ cash: 1000, position: 0, equity: 1000 });
  const [feed, setFeed] = useState([]);
  const [priceSeries, setPriceSeries] = useState([{ tick: 0, price: 100 }]);
  const [tradeMarkers, setTradeMarkers] = useState([]);

  const [activeTab, setActiveTab] = useState("game");

  const [adminPassword, setAdminPassword] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [adminError, setAdminError] = useState("");
  const [allTrades, setAllTrades] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [perfFullscreen, setPerfFullscreen] = useState(false);
  const [entryPrice, setEntryPrice] = useState(0);

  const [params, setParams] = useState({
    tick_interval: 1,
    volatility: 0.008,
    drift: 0.0005,
  });

  const wsRef = useRef(null);
  const usernameRef = useRef("connecting...");
  const tickRef = useRef(0);

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "welcome") {
        setUsername(message.username);
        usernameRef.current = message.username;
        setPrice(message.price);
        setSymbol(message.symbol);
        setRunning(message.running);
        setFixedTradeQty(message.fixed_trade_qty || 1000);
        setPortfolio(message.portfolio);
        tickRef.current = 0;
        setPriceSeries([{ tick: 0, price: message.price }]);
        setTradeMarkers([]);
        setFeed((prev) => [
          { id: crypto.randomUUID(), label: `Connected as ${message.username}` },
          ...prev,
        ]);
      }

      if (message.type === "market") {
        setPrice(message.price);
        setRunning(message.running);
        setFixedTradeQty(message.fixed_trade_qty || 1000);
        tickRef.current += 1;
        setPriceSeries((prev) => {
          const next = [...prev, { tick: tickRef.current, price: message.price }].slice(-140);
          return next;
        });
        setTradeMarkers((prev) => prev.filter((m) => m.tick >= tickRef.current - 160));
        if (message.users?.[usernameRef.current]) {
          setPortfolio(message.users[usernameRef.current]);
        }
      }

      if (message.type === "trade") {
        if (message.trade.username === usernameRef.current) {
          setPortfolio(message.portfolio);
          if (message.portfolio.position === 0) {
            setEntryPrice(0);
          } else {
            setEntryPrice(message.trade.price);
          }
        }
        setTradeMarkers((prev) =>
          [
            ...prev,
            {
              id: crypto.randomUUID(),
              tick: tickRef.current,
              price: Number(message.trade.price),
              side: message.trade.side,
              username: message.trade.username,
              qty: message.trade.qty,
            },
          ].slice(-300)
        );
        const line = `${message.trade.username} ${message.trade.side.toUpperCase()} ${message.trade.qty} @ ${message.trade.price}`;
        setFeed((prev) => [{ id: crypto.randomUUID(), label: line }, ...prev.slice(0, 13)]);
      }

      if (message.type === "admin") {
        setRunning(Boolean(message.running));
        setFeed((prev) => [
          { id: crypto.randomUUID(), label: `ADMIN: ${message.message}` },
          ...prev.slice(0, 13),
        ]);
      }

      if (message.type === "error") {
        setFeed((prev) => [
          { id: crypto.randomUUID(), label: `ERROR: ${message.message}` },
          ...prev.slice(0, 13),
        ]);
      }
    };

    return () => ws.close();
  }, []);

  const positionColor = useMemo(() => {
    if (portfolio.position > 0) return "text-positive";
    if (portfolio.position < 0) return "text-negative";
    return "text-ink";
  }, [portfolio.position]);

  const sendOrder = (side) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(
      JSON.stringify({
        type: "trade",
        side,
      })
    );
  };

  const loginAdmin = async () => {
    setAdminError("");
    const res = await fetch(`${API_BASE}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
    });
    if (!res.ok) {
      setAdminToken("");
      setAdminError("Invalid admin password");
      return;
    }
    const data = await res.json();
    setAdminToken(data.token);
  };

  const callAdmin = async (path, method = "POST", body) => {
    if (!adminToken) return;
    const url = `${API_BASE}${path}?token=${encodeURIComponent(adminToken)}`;
    await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  const refreshData = async () => {
    if (!adminToken) return;
    const [tradesRes, usersRes] = await Promise.all([
      fetch(`${API_BASE}/admin/trades?token=${encodeURIComponent(adminToken)}`),
      fetch(`${API_BASE}/admin/users?token=${encodeURIComponent(adminToken)}`),
    ]);
    if (tradesRes.ok) setAllTrades(await tradesRes.json());
    if (usersRes.ok) {
      const data = await usersRes.json();
      setAllUsers(data.users || []);
    }
  };

  const userStats = useMemo(() => {
    const tradesByUser = {};
    for (const trade of allTrades) {
      if (!tradesByUser[trade.username]) tradesByUser[trade.username] = [];
      tradesByUser[trade.username].push(trade);
    }
    const statsMap = {};
    for (const user of allUsers) {
      const trades = tradesByUser[user.username] || [];
      let pos = 0;
      let avgCost = 0;
      const closedPnLs = [];
      for (const t of trades) {
        const qty = t.qty;
        const tp = t.price;
        const isBuy = t.side === "buy";
        if (pos === 0) {
          avgCost = tp;
          pos = isBuy ? qty : -qty;
        } else if (isBuy) {
          if (pos > 0) {
            avgCost = (pos * avgCost + qty * tp) / (pos + qty);
            pos += qty;
          } else {
            closedPnLs.push(Math.min(qty, Math.abs(pos)) * (avgCost - tp));
            pos += qty;
            if (pos > 0) avgCost = tp;
          }
        } else {
          if (pos < 0) {
            avgCost = (Math.abs(pos) * avgCost + qty * tp) / (Math.abs(pos) + qty);
            pos -= qty;
          } else {
            closedPnLs.push(Math.min(qty, pos) * (tp - avgCost));
            pos -= qty;
            if (pos < 0) avgCost = tp;
          }
        }
      }
      const maxPositive = closedPnLs.length > 0 ? Math.max(...closedPnLs) : null;
      const maxNegative = closedPnLs.length > 0 ? Math.min(...closedPnLs) : null;
      statsMap[user.username] = {
        maxPositive,
        maxNegative,
        ratio: maxPositive != null && maxNegative != null && maxNegative !== 0
          ? Math.abs(maxPositive / maxNegative)
          : null,
        avgClosed: closedPnLs.length > 0
          ? closedPnLs.reduce((a, b) => a + b, 0) / closedPnLs.length
          : null,
      };
    }
    return statsMap;
  }, [allTrades, allUsers]);

  const tabClass = (tab) =>
    `px-5 py-2 text-sm font-bold tracking-wide transition ${
      activeTab === tab
        ? "bg-ink text-white"
        : "text-muted hover:text-ink hover:bg-surface"
    }`;

  return (
    <div className="min-h-screen p-0 md:p-8 font-body text-ink">
      <div className="mx-auto max-w-5xl">
        <section className="bg-white p-6 shadow-panel border-t-4 border-accent">

          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-muted">Live Asset</p>
              <h1 className="font-display text-xl font-black md:text-5xl">{symbol}</h1>
            </div>
            <div className="text-center">
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-muted">User</p>
              <p className="font-display text-xl font-black md:text-3xl">{username}</p>
            </div>
            <div className="text-right">
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-muted">Price</p>
              <p className="font-display text-2xl font-black text-ink md:text-4xl">${toMoney(price)}</p>
              <p className={`text-sm font-bold ${running ? "text-positive" : "text-negative"}`}>
                {running ? "● LIVE" : "○ STOPPED"}
              </p>
            </div>
          </div>

          {/* Tabs */}
          <div className="mt-6 flex gap-0 border-b-2 border-ink/10 pb-0">
            <button className={tabClass("game")} onClick={() => setActiveTab("game")}>
              Game
            </button>
            <button className={tabClass("admin")} onClick={() => setActiveTab("admin")}>
              Admin
            </button>
          </div>

          {/* Game Tab */}
          {activeTab === "game" && (
            <div className="mt-6 space-y-6">
              <div className="grid grid-cols-3 gap-2 md:gap-4">
                <StatCard
                  label="Position"
                  value={Number(portfolio.position || 0).toFixed(0)}
                  extraClass={positionColor}
                />
                <StatCard
                  label="Unrealized P/L"
                  value={`$${toMoney(portfolio.position * (price - entryPrice))}`}
                  extraClass={portfolio.position * (price - entryPrice) >= 0 ? "text-positive" : "text-negative"}
                />
                <StatCard
                  label="Total P/L"
                  value={`$${toMoney(portfolio.equity - 1000)}`}
                  extraClass={portfolio.equity - 1000 >= 0 ? "text-positive" : "text-negative"}
                />
              </div>

              <div className="bg-white p-4 border-l-4 border-accent">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-muted">Price Graph</p>
                  <div className="flex items-center gap-4 text-xs text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 bg-positive" /> Buy
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 bg-negative" /> Sell
                    </span>
                  </div>
                </div>
                <PriceChart points={priceSeries} markers={tradeMarkers} />
              </div>

              <div className="bg-surface p-5 border-l-4 border-ink">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-muted">Trade Ticket</p>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    className="bg-positive px-6 py-2.5 font-black text-white uppercase tracking-widest text-sm transition hover:brightness-95 disabled:opacity-40"
                    onClick={() => sendOrder("buy")}
                    disabled={!connected || !running || portfolio.position > 0}
                  >
                    Long
                  </button>
                  <button
                    className="bg-negative px-6 py-2.5 font-black text-white uppercase tracking-widest text-sm transition hover:brightness-95 disabled:opacity-40"
                    onClick={() => sendOrder("sell")}
                    disabled={!connected || !running || portfolio.position < 0}
                  >
                    Short
                  </button>
                  <div className="bg-white px-4 py-2.5 text-sm font-semibold text-muted border border-ink/10">
                    Fixed Qty: {fixedTradeQty.toLocaleString()} units
                  </div>
                  <div className="bg-white px-4 py-2.5 text-sm font-semibold text-muted border border-ink/10">
                    1 cent move = $10 PnL
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Admin Tab */}
          {activeTab === "admin" && (
            <div className="mt-6">
              {!adminToken ? (
                <div className="mx-auto max-w-sm space-y-3">
                  <p className="text-sm text-muted">Enter the admin password to continue.</p>
                  <input
                    type="password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && loginAdmin()}
                    placeholder="Admin password"
                    className="w-full border-2 border-ink/20 bg-white px-3 py-2 outline-none focus:border-accent"
                  />
                  <button
                    className="w-full bg-ink px-4 py-2.5 text-white font-bold tracking-widest uppercase text-sm"
                    onClick={loginAdmin}
                  >
                    Login
                  </button>
                  {adminError && <p className="text-sm text-negative font-semibold">{adminError}</p>}
                </div>
              ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              {/* Live Feed */}
              <div className="bg-ink p-4 text-white border-l-4 border-accent">
                <p className="mb-3 text-xs font-black uppercase tracking-[0.2em] text-accent">Live Feed</p>
                <ul className="max-h-56 space-y-1 overflow-auto text-sm">
                  {feed.map((item) => (
                    <li key={item.id} className="border-b border-white/10 pb-1 text-white/80">
                      {item.label}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Admin Controls */}
              <div className="space-y-5">
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-positive uppercase tracking-wide">Admin authenticated.</p>
                    <button
                      className="text-xs text-muted hover:text-negative font-semibold"
                      onClick={() => { setAdminToken(""); setAdminPassword(""); }}
                    >
                      Log out
                    </button>
                  </div>
                  <div className="mt-3 grid gap-2">
                    <button
                      className="bg-positive px-4 py-2 text-white font-black uppercase tracking-widest text-sm"
                      onClick={() => callAdmin("/admin/start")}
                    >
                      Start Game
                    </button>
                    <button
                      className="bg-negative px-4 py-2 text-white font-black uppercase tracking-widest text-sm"
                      onClick={() => callAdmin("/admin/stop")}
                    >
                      Stop + Reset Users
                    </button>
                  </div>
                </div>

                <div className="bg-surface p-4 border-l-4 border-accent">
                  <p className="text-xs font-black uppercase tracking-widest text-muted">Price Parameters</p>
                  <div className="mt-3 grid gap-2 text-sm">
                    <label className="font-semibold text-ink/70">
                      Tick Interval
                      <input
                        type="number"
                        step="0.1"
                        className="mt-1 w-full border-2 border-ink/20 bg-white px-2 py-1 outline-none focus:border-accent"
                        value={params.tick_interval}
                        onChange={(e) =>
                          setParams((p) => ({ ...p, tick_interval: Number(e.target.value) }))
                        }
                      />
                    </label>
                    <label className="font-semibold text-ink/70">
                      Volatility
                      <input
                        type="number"
                        step="0.001"
                        className="mt-1 w-full border-2 border-ink/20 bg-white px-2 py-1 outline-none focus:border-accent"
                        value={params.volatility}
                        onChange={(e) =>
                          setParams((p) => ({ ...p, volatility: Number(e.target.value) }))
                        }
                      />
                    </label>
                    <label className="font-semibold text-ink/70">
                      Drift
                      <input
                        type="number"
                        step="0.0001"
                        className="mt-1 w-full border-2 border-ink/20 bg-white px-2 py-1 outline-none focus:border-accent"
                        value={params.drift}
                        onChange={(e) =>
                          setParams((p) => ({ ...p, drift: Number(e.target.value) }))
                        }
                      />
                    </label>
                    <button
                      className="mt-2 bg-ink px-3 py-2 text-white font-black uppercase tracking-widest text-xs disabled:opacity-40"
                      disabled={!adminToken}
                      onClick={() => callAdmin("/admin/params", "POST", params)}
                    >
                      Update Params
                    </button>
                  </div>
                </div>
              </div>

              {/* All Trades - full width */}
              <div className="bg-white p-4 lg:col-span-2 border-l-4 border-accent">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-black uppercase tracking-widest text-muted">All Trades</p>
                  <button
                    className="border-2 border-ink/20 px-3 py-1 text-xs font-bold uppercase tracking-wide disabled:opacity-40 hover:border-accent"
                    disabled={!adminToken}
                    onClick={refreshData}
                  >
                    Refresh
                  </button>
                </div>
                <ul className="mt-3 max-h-56 space-y-1 overflow-auto text-xs">
                  {allTrades.length === 0 && <li className="text-muted">No trades yet.</li>}
                  {allTrades
                    .slice()
                    .reverse()
                    .map((trade, idx) => (
                      <li key={`${trade.timestamp}-${idx}`} className="bg-surface px-2 py-1 border-l-2 border-accent/50">
                        {trade.username} {trade.side.toUpperCase()} {trade.qty} @ {trade.price}
                      </li>
                    ))}
                </ul>
              </div>

              {/* User Performance - full width */}
              <div className={perfFullscreen ? "fixed inset-0 z-50 bg-white p-6 border-l-4 border-accent overflow-auto" : "bg-white p-4 lg:col-span-2 border-l-4 border-accent"}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-black uppercase tracking-widest text-muted">User Performance</p>
                  <button
                    className="border-2 border-ink/20 px-3 py-1 text-xs font-bold uppercase tracking-wide hover:border-accent"
                    onClick={() => setPerfFullscreen((v) => !v)}
                  >
                    {perfFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                  </button>
                </div>
                <div className="mt-3 overflow-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b-2 border-ink/10 text-muted uppercase tracking-[0.15em]">
                        <th className="pb-2 text-left font-black">User</th>
                        <th className="pb-2 text-right font-black">Worst Open Trade P/L</th>
                        <th className="pb-2 text-right font-black">Best Open Trade P/L</th>
                        <th className="pb-2 text-right font-black">Best / Worst</th>
                        <th className="pb-2 text-right font-black">Avg Closed Trade P/L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allUsers.filter((u) => {
                          const s = userStats[u.username] || {};
                          return s.maxNegative != null || s.maxPositive != null || s.avgClosed != null;
                        }).length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-2 text-muted">No closed trades yet.</td>
                        </tr>
                      )}
                      {allUsers.filter((u) => {
                          const s = userStats[u.username] || {};
                          return s.maxNegative != null || s.maxPositive != null || s.avgClosed != null;
                        }).map((user) => {
                        const s = userStats[user.username] || {};
                        return (
                          <tr key={user.username} className="border-b border-ink/5 hover:bg-surface">
                            <td className="py-1.5 font-bold">{user.username}</td>
                            <td className={`py-1.5 text-right font-semibold ${s.maxNegative != null && s.maxNegative < 0 ? "text-negative" : "text-ink"}`}>
                              {s.maxNegative != null ? `$${toMoney(s.maxNegative)}` : "—"}
                            </td>
                            <td className={`py-1.5 text-right font-semibold ${s.maxPositive != null && s.maxPositive > 0 ? "text-positive" : "text-ink"}`}>
                              {s.maxPositive != null ? `$${toMoney(s.maxPositive)}` : "—"}
                            </td>
                            <td className="py-1.5 text-right font-semibold text-ink">
                              {s.ratio != null ? Number(s.ratio).toFixed(2) : "—"}
                            </td>
                            <td className={`py-1.5 text-right font-semibold ${s.avgClosed != null && s.avgClosed > 0 ? "text-positive" : s.avgClosed != null && s.avgClosed < 0 ? "text-negative" : "text-ink"}`}>
                              {s.avgClosed != null ? `$${toMoney(s.avgClosed)}` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            )}
          </div>
          )}

        </section>
      </div>
    </div>
  );
}

function PriceChart({ points, markers }) {
  const width = 1000;
  const height = 260;
  const padding = 24;
  const ticks = points.map((p) => p.tick);
  const prices = points.map((p) => p.price);

  const minTick = Math.min(...ticks);
  const maxTick = Math.max(...ticks);
  const priceMinRaw = Math.min(...prices);
  const priceMaxRaw = Math.max(...prices);
  const spread = Math.max(priceMaxRaw - priceMinRaw, 0.01);
  const minPrice = priceMinRaw - spread * 0.1;
  const maxPrice = priceMaxRaw + spread * 0.1;

  const xForTick = (tick) => {
    if (maxTick === minTick) {
      return width / 2;
    }
    return padding + ((tick - minTick) / (maxTick - minTick)) * (width - padding * 2);
  };

  const yForPrice = (price) => {
    if (maxPrice === minPrice) {
      return height / 2;
    }
    return padding + ((maxPrice - price) / (maxPrice - minPrice)) * (height - padding * 2);
  };

  const path = points
    .map((p, idx) => `${idx === 0 ? "M" : "L"}${xForTick(p.tick)} ${yForPrice(p.price)}`)
    .join(" ");

  const visibleMarkers = markers.filter((m) => m.tick >= minTick && m.tick <= maxTick);

  return (
    <div className="border-0 border-ink/10 bg-surface p-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full">
        <line
          x1={padding}
          y1={height - padding}
          x2={width - padding}
          y2={height - padding}
          className="stroke-ink/20"
          strokeWidth="1"
        />
        <path d={path} fill="none" stroke="#B8B8B8" strokeWidth="3" strokeLinecap="square" />

        {visibleMarkers.map((marker) => {
          const x = xForTick(marker.tick);
          const y = yForPrice(marker.price);
          const isBuy = marker.side === "buy";
          return (
            <g key={marker.id}>
              <rect
                x={x - 5}
                y={y - 5}
                width="10"
                height="10"
                fill={isBuy ? "#0ee072" : "#fd420e"}
                stroke="#f6f6f6"
                strokeWidth="1.5"
              />
              <title>
                {`${marker.username} ${marker.side.toUpperCase()} ${marker.qty} @ ${Number(marker.price).toFixed(2)}`}
              </title>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex items-center justify-between px-2 text-xs font-semibold text-muted">
        <span>${toMoney(minPrice)}</span>
        <span>${toMoney(maxPrice)}</span>
      </div>
    </div>
  );
}

function StatCard({ label, value, extraClass = "" }) {
  return (
    <div className="bg-white p-2 md:p-4 border-l-4 border-accent">
      <p className="text-[0.6rem] md:text-xs font-bold uppercase tracking-[0.1em] md:tracking-[0.18em] text-muted">{label}</p>
      <p className={`mt-0.5 text-sm md:text-xl font-black ${extraClass}`}>{value}</p>
    </div>
  );
}

export default App;

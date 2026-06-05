import express from 'express';
import { StateManager } from './state';
import path from 'path';
import { marketData, wsHealth } from './websocket';
import { ExecutionEngine } from './execution';

const MARGIN = parseFloat(process.env.MARGIN_PER_TRADE || '10');
const CHART_BARS = 100;

type Timeframe = '5m' | '1h';
const INTERVAL_MS: Record<Timeframe, number> = {
    '5m': 5 * 60 * 1000,
    '1h': 60 * 60 * 1000
};

interface Candle { time: number; open: number; high: number; low: number; close: number; }

function buildCandles(data: any, tf: Timeframe): Candle[] {
    const closes: number[] = data?.[`closes${tf}`] ?? [];
    const opens: number[] = data?.[`opens${tf}`] ?? [];
    const highs: number[] = data?.[`highs${tf}`] ?? [];
    const lows: number[] = data?.[`lows${tf}`] ?? [];
    const lastTs = parseInt(data?.[`lastTs${tf}`] ?? '0', 10);
    if (closes.length < 2 || !lastTs) return [];

    const series = closes.slice(-CHART_BARS);
    const o = opens.slice(-CHART_BARS);
    const h = highs.slice(-CHART_BARS);
    const l = lows.slice(-CHART_BARS);
    const n = series.length;
    return series.map((c, i) => ({
        time: Math.floor((lastTs - (n - 1 - i) * INTERVAL_MS[tf]) / 1000),
        open: o[i] ?? c,
        high: h[i] ?? c,
        low: l[i] ?? c,
        close: c
    }));
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

app.get('/', (req, res) => {
    const tf: Timeframe = req.query.tf === '1h' ? '1h' : '5m';
    
    // Live position snapshot
    const activePositionsWithPrice = StateManager.positions.map(p => {
        const data = marketData[p.symbol];
        const liveClose = data?.closes5m?.[data.closes5m.length - 1];
        const current = (typeof liveClose === 'number' && !isNaN(liveClose)) ? liveClose : p.entryPrice;
        const direction = p.side === 'LONG' ? 1 : -1;
        const pnl = (current - p.entryPrice) * p.qty * direction;
        const pnlPercent = ((current - p.entryPrice) / p.entryPrice) * 100 * direction;
        return { ...p, currentPrice: current, pnl, pnlPercent };
    });

    const dailyLoss = StateManager.dailyLoss;
    const dailyEntries = Object.entries(dailyLoss.realizedR)
        .map(([symbol, r]) => ({ symbol, r }))
        .sort((a, b) => a.r - b.r);
    const dailyTotalR = dailyEntries.reduce((s, e) => s + e.r, 0);
    const dailyTotalUSDT = dailyTotalR * MARGIN;
    const dailyTradeCount = dailyEntries.length;
    const dailyWinCount = dailyEntries.filter(e => e.r > 0).length;
    const dailyLossCount = dailyEntries.filter(e => e.r < 0).length;

    const acct = StateManager.account;
    const wallet = acct ? {
        equity: acct.equity,
        available: acct.available,
        locked: acct.locked,
        unrealizedPL: acct.unrealizedPL,
        ageSec: Math.floor((Date.now() - acct.fetchedAt) / 1000)
    } : null;

    // Build chart cards (Max 16)
    const positionsBySymbol = new Map(activePositionsWithPrice.map(p => [p.symbol, p]));
    const charts = Object.entries(marketData).slice(0, 16).map(([symbol, data]: [string, any]) => {
        const candles = buildCandles(data, tf);
        const price = candles[candles.length - 1]?.close ?? 0;
        const start = candles[0]?.close ?? price;
        const changePct = start > 0 ? ((price - start) / start) * 100 : 0;
        const pricePlace = ExecutionEngine.getPricePlace(symbol);
        const pos = positionsBySymbol.get(symbol);
        const levels = pos ? {
            entry: pos.entryPrice,
            sl: pos.slPrice,
            tp1: pos.tpLevels?.[0] ?? null,
            tp2: pos.tpLevels?.[1] ?? null,
            tpHit: pos.tpHit,
            side: pos.side
        } : null;

        // BACA HASIL CACHE LANGSUNG DARI WEBSOCKET ENGINE (HEMAT CPU SUPER RINGAN)
        const plan = !pos ? data?.currentPlan : null;

        return {
            symbol,
            shortName: symbol.replace('USDT', ''),
            price,
            pricePlace,
            changePct,
            isUp: changePct >= 0,
            candles,
            levels,
            plan,
            position: pos ? { side: pos.side } : null,
            hasData: candles.length >= 2
        };
    });

    // Build equity curve data for chart
    const equityCurve = StateManager.getEquityCurve().map(p => ({
        time: Math.floor(p.time / 1000),
        value: p.equity
    }));

    res.render('dashboard', {
        positions: activePositionsWithPrice,
        wallet,
        charts,
        equityCurve,
        daily: {
            date: dailyLoss.date,
            entries: dailyEntries,
            totalR: dailyTotalR,
            totalUSDT: dailyTotalUSDT,
            tradeCount: dailyTradeCount,
            winCount: dailyWinCount,
            lossCount: dailyLossCount
        },
        config: {
            marginPerTrade: MARGIN
        },
        tf,
        wsHealth: {
            connected: wsHealth.connected,
            status: wsHealth.status,
            lastPongAge: wsHealth.lastPongAge,
            lastMessageAge: wsHealth.lastMessageAge,
            reconnectAttempts: wsHealth.reconnectAttempts
        }
    });
});

app.listen(3000, () => console.log("🚀 Dashboard Web 100% Aktif di http://localhost:3000"));

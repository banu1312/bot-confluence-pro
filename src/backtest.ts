/// <reference types="node" />
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { MarketData } from './smc';
import { Screener } from './screener';
import { getStrategyInstance } from './strategies/StrategyFactory';
import { SmcStrategy, SMCSignal } from './strategies/SmcStrategy';
import { RsiFiboStrategy } from './strategies/RsiFiboStrategy';
import { BaseStrategy } from './strategies/BaseStrategy';

interface Candle {
    ts: number; open: number; high: number; low: number; close: number; volume: number;
}

type EndReason = 'TP_FULL' | 'TP1_BE_HOLD' | 'TP1_BE_STOP' | 'SL' | 'OPEN';

interface Trade {
    symbol: string;
    entryTs: number;
    exitTs: number | null;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    slPrice: number;
    tpLevels: number[];
    tpHit: boolean[];
    breakevenMoved: boolean;
    finalR: number;
    barsHeld: number;
    endReason: EndReason;
    confluence: string[];
}

const BASE = 'https://api.bitget.com';
const WARMUP_BARS = 50;
const WINDOW_BARS = 100;
const HIST_PAGE_LIMIT = 200;    // Bitget history-candles max 200/page
const MS_PER_HOUR = 60 * 60 * 1000;
const PAGE_DELAY_MS = 150;      // ms between paginated fetches to stay within rate limit
const COIN_PAUSE_MS = 8000;     // ms between coins in batch mode

// 15 Mid-Cap, High Volatility, High Volume coins for RSI-FIBO strategy.
// These coins are selected for their strong trending behavior and liquidity.
const COINS_15: string[] = [
    'FETUSDT', 'OPUSDT',  'RUNEUSDT', 'GALAUSDT', 'FILUSDT',
    'TONUSDT', 'APTUSDT', 'SANDUSDT', 'UNIUSDT',  'NEARUSDT',
    'IMXUSDT', 'ARBUSDT', 'LDOUSDT',  'JUPUSDT',  'GMXUSDT'
];

// 40 representative USDT-FUTURES coins matching the live screener universe.
// Same criteria as screener.ts: high-volume, established, SMC-tradeable.
const COINS_40: string[] = [
    'BTCUSDT',  'ETHUSDT',  'SOLUSDT',  'XRPUSDT',  'BNBUSDT',
    'DOGEUSDT', 'ADAUSDT',  'AVAXUSDT', 'LINKUSDT',  'DOTUSDT',
    'UNIUSDT',  'LTCUSDT',  'ATOMUSDT', 'NEARUSDT',  'APTUSDT',
    'ARBUSDT',  'OPUSDT',   'INJUSDT',  'SUIUSDT',   'TIAUSDT',
    'FETUSDT',  'AAVEUSDT', 'TRXUSDT',  'TONUSDT',   'WIFUSDT',
    'JUPUSDT',  'WLDUSDT',  'ORDIUSDT', 'ENAUSDT',   'GMXUSDT',
    'MKRUSDT',  'SANDUSDT', 'AXSUSDT',  'IMXUSDT',   'CRVUSDT',
    'GALAUSDT', 'FILUSDT',  'LDOUSDT',  'STXUSDT',   'RUNEUSDT'
];

// Quality-filtered list: only coins with TP1 fill >= 14% from 365-day backtest.
// Removes 17 chronic underperformers (TP1 fill 0-13%) that drag the portfolio.
// Source: backtest_40coins.log run 2026-05-29.
const COINS_QUALITY: string[] = [
    'BTCUSDT',  'ETHUSDT',  'SOLUSDT',  'XRPUSDT',  'UNIUSDT',
    'LTCUSDT',  'NEARUSDT', 'APTUSDT',  'ARBUSDT',   'OPUSDT',
    'FETUSDT',  'TRXUSDT',  'TONUSDT',  'JUPUSDT',   'ENAUSDT',
    'GMXUSDT',  'SANDUSDT', 'IMXUSDT',  'FILUSDT',   'LDOUSDT',
    'GALAUSDT', 'RUNEUSDT'
];

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchCandlesPage(symbol: string, granularity: string, endTime?: number): Promise<Candle[]> {
    const params: any = {
        symbol, productType: 'USDT-FUTURES', granularity,
        limit: HIST_PAGE_LIMIT
    };
    if (endTime) params.endTime = endTime;

    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const res = await axios.get(`${BASE}/api/v2/mix/market/history-candles`, { params });
            const rows = res.data?.data ?? [];
            return rows.map((r: string[]) => ({
                ts: parseInt(r[0], 10),
                open: parseFloat(r[1]),
                high: parseFloat(r[2]),
                low: parseFloat(r[3]),
                close: parseFloat(r[4]),
                volume: parseFloat(r[5] ?? '0')
            }));
        } catch (e: any) {
            if (e.response?.status === 429) {
                const delay = 6000 * (attempt + 1);
                console.warn(`\n⚠️  Rate limited — waiting ${delay / 1000}s (attempt ${attempt + 1})`);
                await sleep(delay);
            } else {
                throw e;
            }
        }
    }
    return [];
}

async function fetchCandles(symbol: string, granularity: string, count: number): Promise<Candle[]> {
    const collected = new Map<number, Candle>();
    let endTime: number | undefined;
    let pages = 0;
    const maxPages = Math.ceil(count / HIST_PAGE_LIMIT) + 2;

    while (collected.size < count && pages < maxPages) {
        const batch = await fetchCandlesPage(symbol, granularity, endTime);
        if (batch.length === 0) break;
        for (const c of batch) collected.set(c.ts, c);
        const oldestTs = Math.min(...batch.map(c => c.ts));
        endTime = oldestTs - 1;
        pages++;
        if (batch.length < HIST_PAGE_LIMIT) break;
        await sleep(PAGE_DELAY_MS);
    }

    const sorted = Array.from(collected.values()).sort((a, b) => a.ts - b.ts);
    return sorted.slice(-count);
}

const MS_PER_15MIN = 15 * 60 * 1000;
const MS_PER_4HOUR = 4 * 60 * 60 * 1000;
const RSI_PERIOD = 14;

function calculateRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;
    
    const changes: number[] = [];
    for (let i = 1; i < closes.length; i++) {
        changes.push(closes[i] - closes[i - 1]);
    }

    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) avgGain += changes[i];
        else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;

    let rsi = 100 - (100 / (1 + avgGain / (avgLoss === 0 ? 0.001 : avgLoss)));

    for (let i = period; i < changes.length; i++) {
        const gain = changes[i] > 0 ? changes[i] : 0;
        const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        rsi = 100 - (100 / (1 + avgGain / (avgLoss === 0 ? 0.001 : avgLoss)));
    }

    return rsi;
}

// After TP1 is hit, trail SL to this fraction of the TP1 distance above/below entry.
const TP1_TRAIL_FACTOR = 0.8;

function buildMarketDataAt(c5m: Candle[], c15m: Candle[], c1h: Candle[], c4h: Candle[], idx5m: number): MarketData | null {
    if (idx5m < WINDOW_BARS) return null;
    const window5m = c5m.slice(idx5m - WINDOW_BARS + 1, idx5m + 1);
    const lastTs5m = window5m[window5m.length - 1].ts;

    const closed15m = c15m.filter(c => c.ts + MS_PER_15MIN <= lastTs5m + 5 * 60 * 1000);
    if (closed15m.length < 20) return null;
    const window15m = closed15m.slice(-WINDOW_BARS);

    const closed1h = c1h.filter(c => c.ts + MS_PER_HOUR <= lastTs5m + 5 * 60 * 1000);
    if (closed1h.length < WINDOW_BARS) return null;
    const window1h = closed1h.slice(-WINDOW_BARS);

    const closed4h = c4h.filter(c => c.ts + MS_PER_4HOUR <= lastTs5m + 5 * 60 * 1000);
    if (closed4h.length < 10) return null;
    const window4h = closed4h.slice(-WINDOW_BARS);

    return {
        opens5m: window5m.map(c => c.open),
        highs5m: window5m.map(c => c.high),
        lows5m: window5m.map(c => c.low),
        closes5m: window5m.map(c => c.close),
        volumes5m: window5m.map(c => c.volume),
        lastTs5m: String(lastTs5m),
        opens15m: window15m.map(c => c.open),
        highs15m: window15m.map(c => c.high),
        lows15m: window15m.map(c => c.low),
        closes15m: window15m.map(c => c.close),
        volumes15m: window15m.map(c => c.volume),
        lastTs15m: String(window15m[window15m.length - 1].ts),
        opens1h: window1h.map(c => c.open),
        highs1h: window1h.map(c => c.high),
        lows1h: window1h.map(c => c.low),
        closes1h: window1h.map(c => c.close),
        volumes1h: window1h.map(c => c.volume),
        lastTs1h: String(window1h[window1h.length - 1].ts),
        opens4h: window4h.map(c => c.open),
        highs4h: window4h.map(c => c.high),
        lows4h: window4h.map(c => c.low),
        closes4h: window4h.map(c => c.close),
        volumes4h: window4h.map(c => c.volume),
        lastTs4h: String(window4h[window4h.length - 1].ts),
    };
}

interface SimResult {
    finalR: number; tpHit: boolean[]; breakevenMoved: boolean; exitIdx: number; endReason: EndReason;
}

function simulateMultiTPTrade(
    side: 'LONG' | 'SHORT', entry: number, originalSL: number,
    tpLevels: number[], future: Candle[]
): SimResult {
    const n = tpLevels.length;
    const split = 1 / n;
    const tpHit = new Array(n).fill(false);
    let currentSL = originalSL;
    let remainingQty = 1.0;
    let totalR = 0;
    let breakevenMoved = false;
    const rDistance = Math.abs(entry - originalSL);
    const rOf = (exitPrice: number): number =>
        ((exitPrice - entry) / rDistance) * (side === 'LONG' ? 1 : -1);

    for (let i = 0; i < future.length; i++) {
        const c = future[i];
        const slHitBar = side === 'LONG' ? c.low <= currentSL : c.high >= currentSL;
        const tpsHitThisBar: number[] = [];
        for (let t = 0; t < n; t++) {
            if (tpHit[t]) continue;
            const isHit = side === 'LONG' ? c.high >= tpLevels[t] : c.low <= tpLevels[t];
            if (isHit) tpsHitThisBar.push(t);
        }
        if (slHitBar && tpsHitThisBar.length > 0) {
            totalR += remainingQty * rOf(currentSL);
            return { finalR: totalR, tpHit, breakevenMoved, exitIdx: i, endReason: breakevenMoved ? 'TP1_BE_STOP' : 'SL' };
        }
        if (tpsHitThisBar.length > 0) {
            for (const t of tpsHitThisBar) {
                totalR += split * rOf(tpLevels[t]);
                tpHit[t] = true;
                remainingQty -= split;
                if (t === 0 && n > 1) {
                    const tp1 = tpLevels[0];
                    currentSL = side === 'LONG'
                        ? entry + (tp1 - entry) * TP1_TRAIL_FACTOR
                        : entry - (entry - tp1) * TP1_TRAIL_FACTOR;
                    breakevenMoved = true;
                }
                if (remainingQty <= 0.001) {
                    return { finalR: totalR, tpHit, breakevenMoved, exitIdx: i, endReason: 'TP_FULL' };
                }
            }
            continue;
        }
        if (slHitBar) {
            totalR += remainingQty * rOf(currentSL);
            return { finalR: totalR, tpHit, breakevenMoved, exitIdx: i, endReason: breakevenMoved ? 'TP1_BE_STOP' : 'SL' };
        }
    }
    if (breakevenMoved) {
        return { finalR: totalR, tpHit, breakevenMoved, exitIdx: -1, endReason: 'TP1_BE_HOLD' };
    }
    return { finalR: totalR, tpHit, breakevenMoved, exitIdx: -1, endReason: 'OPEN' };
}

async function runBacktest(symbol: string, days: number, verbose: boolean = true): Promise<Trade[]> {
    const bars5m  = days * 24 * 12 + WINDOW_BARS;
    const bars15m = days * 24 * 4  + WINDOW_BARS;
    const bars1h  = days * 24      + WINDOW_BARS;
    const bars4h  = days * 6       + WINDOW_BARS;

    console.log(`\n🔬 ${symbol} | ${days}d | fetching data...`);
    const t0 = Date.now();
    let c5m: Candle[], c15m: Candle[], c1h: Candle[], c4h: Candle[];
    try {
        [c5m, c15m, c1h, c4h] = await Promise.all([
            fetchCandles(symbol, '5m',  bars5m),
            fetchCandles(symbol, '15m', bars15m),
            fetchCandles(symbol, '1H',  bars1h),
            fetchCandles(symbol, '4H',  bars4h),
        ]);
    } catch (e: any) {
        console.error(`❌ ${symbol}: fetch failed — ${e.message}`);
        return [];
    }
    console.log(`   Got ${c5m.length}×5m ${c15m.length}×15m ${c1h.length}×1H ${c4h.length}×4H in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (c5m.length < WINDOW_BARS + 10 || c1h.length < WINDOW_BARS + 5) {
        console.warn(`⚠️  ${symbol}: insufficient data — skipping`);
        return [];
    }

    const strategy = getStrategyInstance(symbol);
    const trades: Trade[] = [];
    let lastProgress = -1;

    const isRsiFibo = strategy.name === 'rsi_fibo';

    for (let i = WINDOW_BARS; i < c5m.length; i++) {
        const progress = Math.floor(((i - WINDOW_BARS) / (c5m.length - WINDOW_BARS)) * 100);
        if (progress >= lastProgress + 20) {
            process.stdout.write(`   ⏳ ${progress}%...\r`);
            lastProgress = progress;
        }

        const data = buildMarketDataAt(c5m, c15m, c1h, c4h, i);
        if (!data) continue;

        if (isRsiFibo) {
            const current4hCandle = c4h.find(c => c.ts <= c5m[i].ts && c.ts + MS_PER_4HOUR > c5m[i].ts);
            if (!current4hCandle) continue;

            const prev4hCandle = c4h.find(c => c.ts < current4hCandle.ts && c.ts + MS_PER_4HOUR <= current4hCandle.ts);
            if (!prev4hCandle) continue;

            const is4hClose = c5m[i].ts >= current4hCandle.ts + MS_PER_4HOUR - 5 * 60 * 1000;
            if (!is4hClose) continue;

            const triggerContext = await (strategy as RsiFiboStrategy).checkHTFTrigger(symbol, {
                open: current4hCandle.open,
                high: current4hCandle.high,
                low: current4hCandle.low,
                close: current4hCandle.close,
                ts: current4hCandle.ts
            });

            if (!triggerContext) continue;

            const entryPrice = triggerContext.fibo786;
            const side = triggerContext.side;
            const slPrice = side === 'SHORT' ? entryPrice * 1.05 : entryPrice * 0.95;
            
            const future15m = c15m.filter(c => c.ts > current4hCandle.ts);
            let fillIdx = -1;
            for (let j = 0; j < future15m.length; j++) {
                const isFill = side === 'SHORT' 
                    ? future15m[j].high >= entryPrice 
                    : future15m[j].low <= entryPrice;
                if (isFill) {
                    fillIdx = j;
                    break;
                }
            }

            if (fillIdx === -1) continue;

            const fillCandle = future15m[fillIdx];
            const future4h = c4h.filter(c => c.ts > fillCandle.ts);
            
            let exitPrice = 0;
            let exitReason: EndReason = 'OPEN';
            let exitIdx = -1;

            for (let j = fillIdx; j < future15m.length; j++) {
                const close15m = future15m[j].close;
                const isBreakout = side === 'SHORT' 
                    ? close15m > entryPrice 
                    : close15m < entryPrice;
                
                if (isBreakout) {
                    exitPrice = close15m;
                    exitReason = 'TP1_BE_STOP';
                    exitIdx = j;
                    break;
                }

                const slHit = side === 'SHORT'
                    ? future15m[j].high >= slPrice
                    : future15m[j].low <= slPrice;
                
                if (slHit) {
                    exitPrice = slPrice;
                    exitReason = 'SL';
                    exitIdx = j;
                    break;
                }

                const current4hAfterFill = future4h.find(c => c.ts <= future15m[j].ts && c.ts + MS_PER_4HOUR > future15m[j].ts);
                if (current4hAfterFill && future15m[j].ts >= current4hAfterFill.ts + MS_PER_4HOUR - 5 * 60 * 1000) {
                    const rsiCloses = c4h
                        .filter(c => c.ts <= current4hAfterFill.ts)
                        .slice(-RSI_PERIOD)
                        .map(c => c.close);
                    
                    if (rsiCloses.length >= RSI_PERIOD) {
                        const rsi = calculateRSI(rsiCloses, RSI_PERIOD);
                        const tpCondition = side === 'SHORT' 
                            ? rsi < 30 
                            : rsi > 70;
                        
                        if (tpCondition) {
                            exitPrice = future15m[j].close;
                            exitReason = 'TP_FULL';
                            exitIdx = j;
                            break;
                        }
                    }
                }
            }

            if (exitIdx === -1) {
                exitPrice = future15m[future15m.length - 1].close;
                exitReason = 'TP1_BE_HOLD';
            }

            const finalR = side === 'SHORT'
                ? (entryPrice - exitPrice) / (exitPrice - slPrice)
                : (exitPrice - entryPrice) / (entryPrice - slPrice);

            trades.push({
                symbol,
                entryTs: fillCandle.ts,
                exitTs: exitIdx >= 0 ? future15m[exitIdx].ts : null,
                side,
                entryPrice,
                slPrice,
                tpLevels: [exitPrice],
                tpHit: [exitReason === 'TP_FULL'],
                breakevenMoved: false,
                finalR,
                barsHeld: exitIdx >= 0 ? exitIdx + 1 : future15m.length,
                endReason: exitReason,
                confluence: [`RSI=${triggerContext.rsiAtTrigger.toFixed(2)}`, `FIBO=0.786`]
            });

        } else {
            const smcStrategy = strategy as SmcStrategy;
            let signal = smcStrategy.evaluateSMCMTF(symbol, data, '5m');
            if (!signal) {
                const ts5m = c5m[i].ts;
                const is15mClose = c15m.some(c =>
                    c.ts + 15 * 60 * 1000 <= ts5m + 5 * 60 * 1000 &&
                    c.ts + 15 * 60 * 1000 > ts5m - 5 * 60 * 1000
                );
                if (is15mClose) signal = smcStrategy.evaluateSMCMTF(symbol, data, '15m');
            }
            if (!signal) continue;

            const future = c5m.slice(i + 1);
            const sim = simulateMultiTPTrade(signal.side, signal.entryPrice, signal.slPrice, signal.tpLevels, future);

            trades.push({
                symbol,
                entryTs: c5m[i].ts,
                exitTs: sim.exitIdx >= 0 ? future[sim.exitIdx].ts : null,
                side: signal.side,
                entryPrice: signal.entryPrice,
                slPrice: signal.slPrice,
                tpLevels: signal.tpLevels,
                tpHit: sim.tpHit,
                breakevenMoved: sim.breakevenMoved,
                finalR: sim.finalR,
                barsHeld: sim.exitIdx >= 0 ? sim.exitIdx + 1 : c5m.length - i - 1,
                endReason: sim.endReason,
                confluence: [`[${signal.ltfTimeframe}]`, ...signal.confluence]
            });

            if (sim.exitIdx >= 0) i += sim.exitIdx + 1;
            else i = c5m.length;
        }
    }

    process.stdout.write('                    \r');
    console.log(`   📊 ${symbol}: ${trades.length} signals generated`);
    printReport(symbol, days, trades, verbose);
    return trades;
}

// ─── Comprehensive backtest metrics ────────────────────────────────────────
interface BacktestMetrics {
    totalTrades: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    expectancy: number;
    netProfit: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
    sharpeRatio: number;
    sortinoRatio: number;
    calmarRatio: number;
    recoveryFactor: number;
    ulcerIndex: number;
    timeInMarket: number; // percentage of bars where position was open
    avgBarsHeld: number;
    tp1FillRate: number;
    rrRatio?: number;
}

function calculateMetrics(trades: Trade[], totalBars: number): BacktestMetrics {
    const n = trades.length;
    if (n === 0) {
        return {
            totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0,
            profitFactor: 0, expectancy: 0, netProfit: 0,
            maxDrawdown: 0, maxDrawdownPct: 0,
            maxConsecutiveWins: 0, maxConsecutiveLosses: 0,
            sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
            recoveryFactor: 0, ulcerIndex: 0,
            timeInMarket: 0, avgBarsHeld: 0, tp1FillRate: 0
        };
    }

    const winners = trades.filter(t => t.finalR > 0);
    const losers = trades.filter(t => t.finalR < 0);
    const winRate = winners.length / n;

    const avgWin = winners.length > 0
        ? winners.reduce((s, t) => s + t.finalR, 0) / winners.length
        : 0;
    const avgLoss = losers.length > 0
        ? losers.reduce((s, t) => s + t.finalR, 0) / losers.length
        : 0;

    const grossProfit = winners.reduce((s, t) => s + t.finalR, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.finalR, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const netProfit = trades.reduce((s, t) => s + t.finalR, 0);
    const expectancy = netProfit / n;

    // Max drawdown (in R units)
    let equity = 0, peak = 0, maxDD = 0;
    for (const t of trades) {
        equity += t.finalR;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDD) maxDD = dd;
    }
    const maxDrawdown = maxDD;
    const maxDrawdownPct = peak > 0 ? maxDD / peak : 0;

    // Consecutive wins/losses
    let curWin = 0, curLoss = 0, maxWin = 0, maxLoss = 0;
    for (const t of trades) {
        if (t.finalR > 0) { curWin++; curLoss = 0; if (curWin > maxWin) maxWin = curWin; }
        else if (t.finalR < 0) { curLoss++; curWin = 0; if (curLoss > maxLoss) maxLoss = curLoss; }
        else { curWin = 0; curLoss = 0; }
    }

    // Sharpe ratio (annualized, using R as return)
    const returns = trades.map(t => t.finalR);
    const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(365) : 0; // annualized (365 days)

    // Sortino ratio (downside deviation only)
    const downsideReturns = returns.filter(r => r < 0);
    const downsideVariance = downsideReturns.length > 0
        ? downsideReturns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / downsideReturns.length
        : 0;
    const downsideDev = Math.sqrt(downsideVariance);
    const sortinoRatio = downsideDev > 0 ? (avgReturn / downsideDev) * Math.sqrt(365) : 0;

    // Calmar ratio (annualized return / max drawdown)
    const annualizedReturn = avgReturn * 365; // assuming 1 trade per day average
    const calmarRatio = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

    // Recovery factor
    const recoveryFactor = maxDrawdown > 0 ? netProfit / maxDrawdown : 0;

    // Ulcer Index (measure of downside volatility)
    const ulcerIndex = calculateUlcerIndex(trades);

    // Time in market (percentage of bars where position was open)
    const totalBarsHeld = trades.reduce((s, t) => s + t.barsHeld, 0);
    const timeInMarket = totalBars > 0 ? totalBarsHeld / totalBars : 0;

    // Average bars held
    const avgBarsHeld = trades.reduce((s, t) => s + t.barsHeld, 0) / n;

    // TP1 fill rate
    const tp1FillRate = trades.filter(t => t.tpHit[0]).length / n;

    const rrRatio = avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : (avgWin > 0 ? Infinity : 0);

    return {
        totalTrades: n,
        winRate,
        avgWin,
        avgLoss,
        profitFactor,
        expectancy,
        netProfit,
        maxDrawdown,
        maxDrawdownPct,
        maxConsecutiveWins: maxWin,
        maxConsecutiveLosses: maxLoss,
        sharpeRatio,
        sortinoRatio,
        calmarRatio,
        recoveryFactor,
        ulcerIndex,
        timeInMarket,
        avgBarsHeld,
        tp1FillRate,
        rrRatio
    };
}

// ─── Ulcer Index calculation ───────────────────────────────────────────────
// Measures downside volatility based on percentage drawdowns from peak.
function calculateUlcerIndex(trades: Trade[]): number {
    if (trades.length === 0) return 0;

    let equity = 0, peak = 0;
    const drawdowns: number[] = [];
    for (const t of trades) {
        equity += t.finalR;
        if (equity > peak) peak = equity;
        const dd = peak > 0 ? (peak - equity) / peak : 0;
        drawdowns.push(dd);
    }
    const sumSquares = drawdowns.reduce((s, dd) => s + dd * dd, 0);
    return Math.sqrt(sumSquares / drawdowns.length);
}

function printReport(symbol: string, days: number, trades: Trade[], detailed: boolean = true): void {
    const counts: Record<EndReason, number> = {
        'TP_FULL': 0, 'TP1_BE_HOLD': 0, 'TP1_BE_STOP': 0, 'SL': 0, 'OPEN': 0
    };
    for (const t of trades) counts[t.endReason]++;

    const winners = trades.filter(t => t.finalR > 0).length;
    const losers = trades.filter(t => t.finalR < 0).length;
    const flat = trades.filter(t => t.finalR === 0).length;
    const tp1HitCount = trades.filter(t => t.tpHit[0]).length;
    const totalR = trades.reduce((s, t) => s + t.finalR, 0);
    const avgR = trades.length > 0 ? totalR / trades.length : 0;
    const closed = trades.filter(t => t.endReason !== 'OPEN' && t.endReason !== 'TP1_BE_HOLD').length;
    const avgBarsHeld = closed > 0
        ? trades.filter(t => t.endReason !== 'OPEN').reduce((s, t) => s + t.barsHeld, 0) / closed
        : 0;

    let equity = 0, peak = 0, maxDD = 0, curLoss = 0, maxLoss = 0;
    for (const t of trades) {
        equity += t.finalR;
        if (t.finalR < 0) { curLoss++; maxLoss = Math.max(maxLoss, curLoss); }
        else curLoss = 0;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDD) maxDD = dd;
    }

    if (!detailed) {
        // One-liner for batch mode
        const mark = equity > 0 ? '✅' : equity < 0 ? '❌' : '➖';
        console.log(`   ${mark} ${symbol.padEnd(11)} signals=${String(trades.length).padStart(3)}  win=${String(winners).padStart(2)}/${String(losers).padStart(2)}  TP1=${trades.length > 0 ? (tp1HitCount/trades.length*100).toFixed(0)+'%' : '0%'}  Net=${equity >= 0 ? '+' : ''}${equity.toFixed(2)}R  avgR=${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R  DD=${maxDD.toFixed(1)}R`);
        return;
    }

    console.log(`\n📈 ─── BACKTEST: ${symbol} (${days}d) ───`);
    console.log(`Signals fired:        ${trades.length}`);
    if (trades.length === 0) {
        console.log(`⚠️  No signals fired.`);
        return;
    }
    console.log(`\n  Outcome breakdown:`);
    console.log(`    Full close at TP2 (best):    ${counts.TP_FULL}`);
    console.log(`    TP1 hit → Trail SL stopped:   ${counts.TP1_BE_STOP}`);
    console.log(`    TP1 hit → still open at end:  ${counts.TP1_BE_HOLD}`);
    console.log(`    SL hit before any TP (worst): ${counts.SL}`);
    console.log(`    Never resolved (open):        ${counts.OPEN}`);
    console.log(`\n  TP1 fill rate:        ${(tp1HitCount / trades.length * 100).toFixed(1)}% (${tp1HitCount}/${trades.length})`);
    console.log(`  Profitable trades:    ${winners} (${(winners / trades.length * 100).toFixed(1)}%)`);
    console.log(`  Break-even (0R):      ${flat}`);
    console.log(`  Losers (<0R):         ${losers}`);
    const totalBars = days * 24 * 12; // 5m bars in the period
    const metrics = calculateMetrics(trades, totalBars);

    console.log(`\n  Avg R per trade:      ${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R`);
    console.log(`  Net R-multiple:       ${equity >= 0 ? '+' : ''}${equity.toFixed(2)}R`);
    console.log(`  Max drawdown:         ${maxDD.toFixed(2)}R`);
    console.log(`  Max DD %:             ${(metrics.maxDrawdownPct * 100).toFixed(1)}%`);
    console.log(`  Max loss streak:      ${maxLoss}`);
    console.log(`  Max win streak:       ${metrics.maxConsecutiveWins}`);
    console.log(`  Avg win:              ${metrics.avgWin >= 0 ? '+' : ''}${metrics.avgWin.toFixed(2)}R`);
    console.log(`  Avg loss:             ${metrics.avgLoss.toFixed(2)}R`);
    console.log(`  Profit factor:        ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}`);
    console.log(`  Expectancy:           ${metrics.expectancy >= 0 ? '+' : ''}${metrics.expectancy.toFixed(2)}R`);
    console.log(`  Sharpe ratio (ann.):  ${metrics.sharpeRatio.toFixed(2)}`);
    console.log(`  Sortino ratio (ann.): ${metrics.sortinoRatio.toFixed(2)}`);
    console.log(`  Calmar ratio:         ${metrics.calmarRatio.toFixed(2)}`);
    console.log(`  Recovery factor:      ${metrics.recoveryFactor.toFixed(2)}`);
    console.log(`  Ulcer index:          ${metrics.ulcerIndex.toFixed(4)}`);
    console.log(`  Time in market:       ${(metrics.timeInMarket * 100).toFixed(1)}%`);
    console.log(`  Avg bars held:        ${avgBarsHeld.toFixed(1)} (${(avgBarsHeld * 5 / 60).toFixed(1)}h)`);
    console.log(`\n💰 If risking 10 USDT per trade: net = ${(equity * 10).toFixed(2)} USDT`);

    console.log(`\n📋 Last 10 trades:`);
    for (const t of trades.slice(-10)) {
        const date = new Date(t.entryTs).toISOString().slice(0, 16).replace('T', ' ');
        const mark = t.finalR > 0 ? '✅' : t.finalR < 0 ? '❌' : '➖';
        const tpStr = t.tpHit.map((h, i) => h ? `TP${i + 1}✓` : `TP${i + 1}✗`).join(' ');
        console.log(`  ${date} ${t.side.padEnd(5)} ${mark} ${t.finalR.toFixed(2)}R | ${t.endReason.padEnd(13)} | ${tpStr} | held ${t.barsHeld}b`);
    }
}

function printCombinedReport(allTrades: Trade[], days: number): void {
    if (allTrades.length === 0) {
        console.log(`\n⚠️  No trades across all coins — strategy may be too restrictive.`);
        return;
    }

    const byCoin: Record<string, Trade[]> = {};
    for (const t of allTrades) {
        if (!byCoin[t.symbol]) byCoin[t.symbol] = [];
        byCoin[t.symbol].push(t);
    }

    const totalR = allTrades.reduce((s, t) => s + t.finalR, 0);
    const avgR = totalR / allTrades.length;
    const winners = allTrades.filter(t => t.finalR > 0).length;
    const losers = allTrades.filter(t => t.finalR < 0).length;
    const tp1Count = allTrades.filter(t => t.tpHit[0]).length;
    const profitableCoins = Object.values(byCoin).filter(ts => ts.reduce((s,t) => s+t.finalR, 0) > 0).length;

    // Calculate comprehensive metrics
    const totalBars = days * 24 * 12; // 5m bars in the period
    const metrics = calculateMetrics(allTrades, totalBars);

    // Per-coin table sorted by Net R descending
    const coinStats = Object.entries(byCoin)
        .map(([sym, trades]) => {
            const net = trades.reduce((s, t) => s + t.finalR, 0);
            const w = trades.filter(t => t.finalR > 0).length;
            const tp1 = trades.filter(t => t.tpHit[0]).length;
            return { sym, n: trades.length, w, tp1, net };
        })
        .sort((a, b) => b.net - a.net);

    console.log(`\n${'═'.repeat(68)}`);
    console.log(`  COMBINED REPORT: ${Object.keys(byCoin).length} coins × ${days} days`);
    console.log(`${'═'.repeat(68)}`);
    console.log(`  Total signals fired:   ${allTrades.length}  (${(allTrades.length / Object.keys(byCoin).length / days * 30).toFixed(1)}/coin/month)`);
    console.log(`  Overall win rate:      ${(winners / allTrades.length * 100).toFixed(1)}%  (${winners}W / ${losers}L)`);
    console.log(`  TP1 fill rate:         ${(tp1Count / allTrades.length * 100).toFixed(1)}%`);
    console.log(`  Profitable coins:      ${profitableCoins}/${Object.keys(byCoin).length}`);
    console.log(`  Net R (portfolio):     ${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R`);
    console.log(`  Avg R per trade:       ${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)}R`);
    console.log(`  Max portfolio DD:      ${metrics.maxDrawdown.toFixed(2)}R`);
    console.log(`  Max DD %:              ${(metrics.maxDrawdownPct * 100).toFixed(1)}%`);
    console.log(`  Max loss streak:       ${metrics.maxConsecutiveLosses}`);
    console.log(`  Max win streak:        ${metrics.maxConsecutiveWins}`);
    console.log(`  Avg win:               ${metrics.avgWin >= 0 ? '+' : ''}${metrics.avgWin.toFixed(2)}R`);
    console.log(`  Avg loss:              ${metrics.avgLoss.toFixed(2)}R`);
    console.log(`  RR ratio (avg win / avg loss): ${metrics.rrRatio === undefined ? '0.00' : (metrics.rrRatio === Infinity ? '∞' : metrics.rrRatio.toFixed(2))}`);
    console.log(`  Profit factor:         ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}`);
    console.log(`  Expectancy:            ${metrics.expectancy >= 0 ? '+' : ''}${metrics.expectancy.toFixed(2)}R`);
    console.log(`  Sharpe ratio (ann.):   ${metrics.sharpeRatio.toFixed(2)}`);
    console.log(`  Sortino ratio (ann.):  ${metrics.sortinoRatio.toFixed(2)}`);
    console.log(`  Calmar ratio:          ${metrics.calmarRatio.toFixed(2)}`);
    console.log(`  Recovery factor:       ${metrics.recoveryFactor.toFixed(2)}`);
    console.log(`  Ulcer index:           ${metrics.ulcerIndex.toFixed(4)}`);
    console.log(`  Time in market:        ${(metrics.timeInMarket * 100).toFixed(1)}%`);
    console.log(`  Avg bars held:         ${metrics.avgBarsHeld.toFixed(1)} (${(metrics.avgBarsHeld * 5 / 60).toFixed(1)}h)`);
    console.log(`\n  💰 If risking 10 USDT/trade: net = ${(totalR * 10).toFixed(2)} USDT`);
    console.log(`     (portfolio DD never exceeded ${(metrics.maxDrawdown * 10).toFixed(2)} USDT)`);

    console.log(`\n  Per-coin ranking (all ${coinStats.length} coins):`);
    console.log(`  ${'Symbol'.padEnd(12)} ${'Sig'.padEnd(5)} ${'W/L'.padEnd(8)} ${'TP1%'.padEnd(7)} ${'Net R'.padEnd(10)}`);
    console.log(`  ${'-'.repeat(45)}`);
    for (const { sym, n, w, tp1, net } of coinStats) {
        const l = n - w;
        const tp1Pct = n > 0 ? (tp1/n*100).toFixed(0)+'%' : '0%';
        const mark = net > 0 ? '✅' : net < 0 ? '❌' : '➖';
        const netStr = (net >= 0 ? '+' : '') + net.toFixed(2) + 'R';
        console.log(`  ${mark} ${sym.padEnd(11)} ${String(n).padEnd(5)} ${(w+'W/'+l+'L').padEnd(8)} ${tp1Pct.padEnd(7)} ${netStr}`);
    }

    // Top 5 best individual trades
    const best = [...allTrades].sort((a, b) => b.finalR - a.finalR).slice(0, 5);
    console.log(`\n  Top 5 individual trades:`);
    for (const t of best) {
        const date = new Date(t.entryTs).toISOString().slice(0, 10);
        console.log(`    ${date}  ${t.symbol.padEnd(11)} ${t.side}  +${t.finalR.toFixed(2)}R  (${t.endReason})`);
    }

    console.log(`${'═'.repeat(68)}`);
}

// ─── Fungsi untuk menyimpan log ke file ────────────────────────────────────
function saveLogToFile(logContent: string, symbol: string, days: number): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeSymbol = symbol.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `backtest_${safeSymbol}_${days}d_${timestamp}.log`;
    const filepath = path.join(__dirname, '..', 'logs', filename);
    
    // Buat direktori logs jika belum ada
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(filepath, logContent, 'utf-8');
    console.log(`\n📝 [LOG] Saved to ${filepath}`);
}

// ─── Fungsi untuk menyimpan combined log ke file ───────────────────────────
function saveCombinedLogToFile(logContent: string, symbols: string[], days: number): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeSymbols = symbols.length <= 3 
        ? symbols.map(s => s.replace(/[^a-zA-Z0-9]/g, '_')).join('_')
        : `${symbols.length}coins`;
    const filename = `backtest_${safeSymbols}_${days}d_${timestamp}.log`;
    const filepath = path.join(__dirname, '..', 'logs', filename);
    
    // Buat direktori logs jika belum ada
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(filepath, logContent, 'utf-8');
    console.log(`\n📝 [LOG] Combined report saved to ${filepath}`);
}

async function main() {
    const args = process.argv.slice(2);
    let symbols: string[] = [];
    let days = 1095; // Default: 3 years

    // Helper: cari argumen angka (jumlah hari) di antara argumen non-flag
    function extractDaysArg(args: string[]): { days: number; rest: string[] } {
        const rest: string[] = [];
        let foundDays: number | null = null;
        for (const a of args) {
            if (a.startsWith('--')) {
                rest.push(a);
                continue;
            }
            const num = parseInt(a, 10);
            if (!isNaN(num) && num > 0 && foundDays === null) {
                foundDays = num;
            } else {
                rest.push(a);
            }
        }
        return { days: foundDays ?? 1095, rest };
    }

    const { days: extractedDays, rest: cleanArgs } = extractDaysArg(args);
    days = extractedDays;

    if (cleanArgs.includes('--preset=15')) {
        symbols = COINS_15;
    } else if (cleanArgs.includes('--preset=40')) {
        symbols = COINS_40;
    } else if (cleanArgs.includes('--preset=quality')) {
        symbols = COINS_QUALITY;
    } else if (cleanArgs.includes('--preset=3year')) {
        symbols = COINS_15;
        days = 1095; // ~3 years (June 2023 – June 2026)
    } else if (cleanArgs.includes('--preset=screener')) {
        console.log('\n📡 Running live screener to get today\'s coin list...');
        symbols = await Screener.getTopTrendingCoins(20);
        if (symbols.length === 0) { console.error('❌ Screener returned 0 coins'); process.exit(1); }
    } else if (cleanArgs.length > 0) {
        // Argumen non-flag dianggap sebagai simbol koin
        symbols = cleanArgs.map(s => s.toUpperCase());
        if (symbols.length === 0) symbols = COINS_15;
    } else {
        // Default: run all 15 coins for 3 years
        symbols = COINS_15;
        days = 1095;
    }

    if (isNaN(days) || days < 1) {
        console.error('Usage: ts-node src/backtest.ts [--preset=15|40|quality|screener] [SYMBOL...] DAYS');
        process.exit(1);
    }

    const isBatch = symbols.length > 1;
    console.log(`\n🚀 Backtest: ${symbols.length} coin(s) × ${days} days`);
    if (isBatch) {
        const estMin = Math.ceil(symbols.length * (days * 0.00019 + 20) / 60);
        console.log(`⏱  Estimated time: ~${estMin} min  (rate-limit pauses included)`);
    }

    const allTrades: Trade[] = [];
    const startTime = Date.now();
    const logLines: string[] = [];

    for (let idx = 0; idx < symbols.length; idx++) {
        const coinStartTime = Date.now();
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📊 [${idx + 1}/${symbols.length}] Processing ${symbols[idx]}...`);
        console.log(`${'='.repeat(60)}`);

        if (idx > 0) {
            console.log(`\n⏸  ${COIN_PAUSE_MS / 1000}s pause...`);
            await sleep(COIN_PAUSE_MS);
        }
        const trades = await runBacktest(symbols[idx], days, !isBatch);
        allTrades.push(...trades);

        const coinElapsed = (Date.now() - coinStartTime) / 1000;
        const totalElapsed = (Date.now() - startTime) / 1000;
        const avgPerCoin = totalElapsed / (idx + 1);
        const remaining = symbols.length - idx - 1;
        const eta = avgPerCoin * remaining;
        console.log(`   ⏱  ${symbols[idx]} took ${coinElapsed.toFixed(1)}s | Total elapsed: ${(totalElapsed / 60).toFixed(1)}m | ETA: ${(eta / 60).toFixed(1)}m`);
    }

    const totalElapsed = (Date.now() - startTime) / 1000;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🏁 BACKTEST COMPLETE in ${(totalElapsed / 60).toFixed(1)} minutes`);
    console.log(`${'='.repeat(60)}`);

    if (isBatch) {
        // Capture combined report output
        const combinedReportLines: string[] = [];
        const originalLog = console.log;
        console.log = (...args: any[]) => {
            const line = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
            combinedReportLines.push(line);
            originalLog(...args);
        };
        
        console.log(`\n📊 Total signals across all coins: ${allTrades.length}`);
        printCombinedReport(allTrades, days);
        
        // Restore console.log
        console.log = originalLog;
        
        // Save combined report to file
        saveCombinedLogToFile(combinedReportLines.join('\n'), symbols, days);
    } else {
        // For single coin, save individual report
        const reportLines: string[] = [];
        const originalLog = console.log;
        console.log = (...args: any[]) => {
            const line = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
            reportLines.push(line);
            originalLog(...args);
        };
        
        printReport(symbols[0], days, allTrades, true);
        
        // Restore console.log
        console.log = originalLog;
        
        // Save individual report to file
        saveLogToFile(reportLines.join('\n'), symbols[0], days);
    }
}

main().catch(e => {
    console.error('❌ Backtest error:', e.message);
    process.exit(1);
});

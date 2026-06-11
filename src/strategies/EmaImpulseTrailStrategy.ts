import { BaseStrategy } from './BaseStrategy';
import type { SMCSignal } from './SmcStrategy';

// 4H EMA50 impulse-cross entry + chandelier ATR trail exit.
// Mirrors runEmaImpulseBacktest(..., useTrailing=true) in src/backtest.ts.
// 5yr validation (22 coins, 1825d): +398.3R net-fee, expectancy +0.23R, WR 38.6%.
const EMA_PERIOD = 50;
const ATR_PERIOD = 14;
const VOL_SMA_PERIOD = 20;
const BODY_ATR_MULT = 1.0;
const VOL_MULT = 1.5;
const SL_ATR_MULT = 2.0;
const TRAIL_ATR_MULT = 3.0;
const TP_ATR_MULT = 25.0;

interface TrailState {
    side: 'LONG' | 'SHORT';
    entry: number;
    atr: number;
    stop: number;
    extreme: number;
    tp: number;
}

function computeEMA(closes: number[], period: number): (number | null)[] {
    const n = closes.length;
    const out: (number | null)[] = new Array(n).fill(null);
    if (n < period) return out;
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    out[period - 1] = sum / period;
    for (let i = period; i < n; i++) {
        out[i] = closes[i] * k + (out[i - 1] as number) * (1 - k);
    }
    return out;
}

function computeATR(highs: number[], lows: number[], closes: number[], period: number): (number | null)[] {
    const n = closes.length;
    const out: (number | null)[] = new Array(n).fill(null);
    if (n <= period) return out;
    const tr: number[] = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
        tr[i] = Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1])
        );
    }
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr[i];
    out[period] = sum / period;
    for (let i = period + 1; i < n; i++) {
        out[i] = ((out[i - 1] as number) * (period - 1) + tr[i]) / period;
    }
    return out;
}

function computeSMA(values: number[], period: number): (number | null)[] {
    const n = values.length;
    const out: (number | null)[] = new Array(n).fill(null);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += values[i];
        if (i >= period) sum -= values[i - period];
        if (i >= period - 1) out[i] = sum / period;
    }
    return out;
}

export class EmaImpulseTrailStrategy implements BaseStrategy {
    name = 'ema_impulse_trail';
    private trailState: Map<string, TrailState> = new Map();

    async scanDailyWatchlist(): Promise<string[]> {
        return [];
    }

    async checkHTFTrigger(): Promise<any> {
        return null;
    }

    async checkLTFEntry(): Promise<any> {
        return null;
    }

    async manageActivePosition(): Promise<any> {
        return null;
    }

    // Called on each closed 4H candle when no position is open for `symbol`.
    public evaluateEntry(symbol: string, m: any): SMCSignal | null {
        if (this.trailState.has(symbol)) return null;

        const closes: number[] = m.closes4h ?? [];
        const highs: number[] = m.highs4h ?? [];
        const lows: number[] = m.lows4h ?? [];
        const opens: number[] = m.opens4h ?? [];
        const vols: number[] = m.volumes4h ?? [];

        const n = closes.length;
        if (n < EMA_PERIOD + VOL_SMA_PERIOD + 2) return null;

        const emaArr = computeEMA(closes, EMA_PERIOD);
        const atrArr = computeATR(highs, lows, closes, ATR_PERIOD);
        const volSmaArr = computeSMA(vols, VOL_SMA_PERIOD);

        const i = n - 1;
        const e = emaArr[i], ePrev = emaArr[i - 1], a = atrArr[i], vs = volSmaArr[i];
        if (e === null || ePrev === null || a === null || vs === null) return null;

        const close = closes[i], prevClose = closes[i - 1];
        const crossUp = close > e && prevClose <= ePrev;
        const crossDn = close < e && prevClose >= ePrev;
        const body = Math.abs(close - opens[i]);
        const impulsive = body >= BODY_ATR_MULT * a && vols[i] >= VOL_MULT * vs;

        const side: 'LONG' | 'SHORT' | null = (crossUp && impulsive) ? 'LONG' : (crossDn && impulsive) ? 'SHORT' : null;
        if (!side) return null;

        const entry = close;
        const sl = side === 'LONG' ? entry - SL_ATR_MULT * a : entry + SL_ATR_MULT * a;
        const tp = side === 'LONG' ? entry + TP_ATR_MULT * a : entry - TP_ATR_MULT * a;

        this.trailState.set(symbol, { side, entry, atr: a, stop: sl, extreme: entry, tp });

        console.log(`📊 [EMA-IMPULSE] ${symbol} ${side} signal @ ${entry} | SL=${sl.toFixed(6)} TP=${tp.toFixed(6)} | body=${(body / a).toFixed(1)}xATR vol=${(vols[i] / vs).toFixed(1)}x`);

        return {
            symbol, side, entryPrice: entry, slPrice: sl,
            tpLevels: [tp], tpPrice: tp,
            confluence: [`cross=${side === 'LONG' ? 'UP' : 'DN'}`, `body=${(body / a).toFixed(1)}xATR`, `vol=${(vols[i] / vs).toFixed(1)}x`],
            ltfTimeframe: '15m'
        };
    }

    // Called on each closed 4H candle when a position is open for `symbol`.
    // Returns a chandelier-trail SL update, or null if the stop hasn't moved.
    // Actual SL/TP fills are executed exchange-side via the plan orders placed at entry.
    public evaluateExit(symbol: string, m: any): { newSlPrice: number } | null {
        const st = this.trailState.get(symbol);
        if (!st) return null;

        const closes: number[] = m.closes4h ?? [];
        const i = closes.length - 1;
        const high: number = m.highs4h[i];
        const low: number = m.lows4h[i];

        if (st.side === 'LONG') {
            if (high > st.extreme) st.extreme = high;
            const newStop = Math.max(st.stop, st.extreme - TRAIL_ATR_MULT * st.atr);
            if (newStop > st.stop) {
                st.stop = newStop;
                return { newSlPrice: newStop };
            }
        } else {
            if (low < st.extreme) st.extreme = low;
            const newStop = Math.min(st.stop, st.extreme + TRAIL_ATR_MULT * st.atr);
            if (newStop < st.stop) {
                st.stop = newStop;
                return { newSlPrice: newStop };
            }
        }
        return null;
    }

    public clearTrail(symbol: string): void {
        this.trailState.delete(symbol);
    }
}

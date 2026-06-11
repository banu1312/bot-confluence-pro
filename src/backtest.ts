/// <reference types="node" />
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { MarketData } from './smc';
import { Screener } from './screener';
import { getStrategyInstance } from './strategies/StrategyFactory';
import { SmcStrategy, SMCSignal } from './strategies/SmcStrategy';
import { BaseStrategy } from './strategies/BaseStrategy';

interface Candle {
    ts: number; open: number; high: number; low: number; close: number; volume: number;
}

type EndReason = 'TP_FULL' | 'TP1_BE_HOLD' | 'TP1_BE_STOP' | 'SL' | 'OPEN' | 'TP_RSI' | 'TRAIL';

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

// Scalp_bb filtered universe: 13 coin yg ber-edge positif di backtest 90d (WR >= 41%).
// Dipisah dari COINS_QUALITY karena scalp mean-reversion cuma jalan di coin yg ranging;
// coin trending/sepi (BTC, OP, dst) konsisten rugi & memperpanjang losing streak → DD naik.
const COINS_SCALP: string[] = [
    'ETHUSDT',  'TRXUSDT',  'LTCUSDT',  'GMXUSDT',  'SOLUSDT',
    'UNIUSDT',  'FILUSDT',  'ARBUSDT',  'GALAUSDT', 'SANDUSDT',
    'NEARUSDT', 'IMXUSDT',  'XRPUSDT'
];

// Donchian curated universe: 19 coin yg ber-edge positif di backtest 5-TAHUN donchian_aggro
// (lintas bull/bear/choppy). Dibuang 3 yg rugi konsisten 5-thn: UNI, LDO, LTC.
// Curation pakai config yg sama (channel 20) — beda channel = beda dud. Utk backtest & live.
const COINS_CURATED: string[] = [
    'BTCUSDT',  'ETHUSDT',  'SOLUSDT',  'XRPUSDT',  'NEARUSDT',
    'APTUSDT',  'ARBUSDT',  'OPUSDT',   'FETUSDT',  'TRXUSDT',
    'TONUSDT',  'JUPUSDT',  'ENAUSDT',  'GMXUSDT',  'SANDUSDT',
    'IMXUSDT',  'FILUSDT',  'GALAUSDT', 'RUNEUSDT'
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
// ─── Fix 1: Daily RSI trend filter ────────────────────────────────────────
const DAILY_RSI_LONG_MIN       = 40;   // LONG hanya jika daily RSI > ini
const DAILY_RSI_SHORT_MAX      = 60;   // SHORT hanya jika daily RSI < ini
// ─── Fix 2: Max concurrent positions ──────────────────────────────────────
const MAX_CONCURRENT_POSITIONS = 3;
// ─── Balance simulation ────────────────────────────────────────────────────
const BACKTEST_INITIAL_BALANCE = 100;   // USDT
// Margin-based sizing — SAMA PERSIS dgn bot live (execution.ts): margin 10% saldo × 20x.
// Sizing skala ikut saldo → ada compounding. Notional = saldo × MARGIN_PCT × LEVERAGE.
const BACKTEST_MARGIN_PCT      = 0.10;  // 10% saldo jadi isolated margin per entry
const BACKTEST_LEVERAGE        = 10;    // 10x — growth agresif (+529%/thn @ DD 74%, sweep 365d)
// ─── Trading fee model ──────────────────────────────────────────────────────
// Fee taker Bitget USDT-futures ~0.06%/sisi. Round-trip (entry+exit) dipotong dari
// tiap trade dalam satuan R: feeR = 2 × fee_per_side × entry / jarak_SL.
// Konsekuensi: stop makin tipis → feeR makin besar (scalp paling kena).
const FEE_PER_SIDE             = 0.0006; // 0.06% per sisi (set 0 utk lihat gross)
// (Sizing lama berbasis margin×leverage bikin risiko per-trade ikut lebar SL —
//  diganti fixed-fractional supaya drawdown terkendali & saldo compound saat edge positif.)

// ─── Scalp Bollinger Band Mean-Reversion strategy (5m) ────────────────────
const SCALP_BB_PERIOD     = 20;   // periode SMA & stdev
const SCALP_BB_STDDEV     = 2;    // lebar band (kelipatan stdev)
const SCALP_RSI_PERIOD    = 14;
const SCALP_RSI_OVERSOLD  = 30;   // RSI <= ini utk LONG
const SCALP_RSI_OVERBOUGHT = 70;  // RSI >= ini utk SHORT
const SCALP_SL_BUFFER     = 0.0015; // SL 0.15% di luar wick candle entry
const SCALP_RR            = 1.5;  // TP = risk * RR (RR 1:1.5 — WR ~42%, sesuai target 40-50%)
const SCALP_EMA_PERIOD    = 50;   // EMA 4H utk filter tren (entry searah tren)

// ─── Trend Pullback-Continuation strategy (H4 trend+ATR, M15 reclaim entry) ─
const MTF_EMA_FAST       = 50;    // EMA cepat H4 (zona value + trend filter)
const MTF_EMA_SLOW       = 200;   // EMA lambat H4 (trend filter)
const MTF_ATR_PERIOD     = 14;    // periode ATR H4 (risk management)
const MTF_SL_ATR_MULT    = 1.5;   // SL = 1.5 * ATR(H4)
const MTF_TP_ATR_MULT    = 3.0;   // TP cap maksimum (×ATR) — exit utama via trailing stop
const MTF_TRAIL_ATR_MULT = 2.0;   // trailing stop = (extreme sejak entry) − 2×ATR → winner dibiarkan lari

// ─── Donchian Breakout trend-following (4H, Turtle-style, fee-immune) ───────
// Dibangun di 4H (data D1 Bitget cuma ~90 candle). Channel 120 bar = breakout 20 hari.
const DON_CHANNEL        = 120;   // breakout = tembus high/low 120 bar 4H (≈20 hari)
const DON_ATR_PERIOD     = 14;    // ATR(4H) utk risk
const DON_SL_ATR_MULT    = 2.0;   // SL awal = 2×ATR(4H)
const DON_TRAIL_ATR_MULT = 3.0;   // chandelier trail = (extreme sejak entry) − 3×ATR
const DON_TP_ATR_MULT    = 25.0;  // TP cap sangat jauh — biar trailing yg dominan (tren lari)
// Varian ofensif (--strategy=donchian_aggro): channel pendek → breakout sering, cocok main
// cepat 1bln-1thn. Trail sedikit lebih lebar utk ekor gemuk.
const DON_AGGRO_CHANNEL  = 20;    // breakout 20 bar 4H (≈3,3 hari)
const DON_AGGRO_TRAIL    = 3.5;   // trail sedikit lebih lebar
const PYRAMID_STEP_ATR   = 1.0;   // tambah 1 unit tiap harga maju 1×ATR searah tren
const PYRAMID_MAX        = 4;     // maksimum 4 unit (gaya Turtle)

// ─── Retest-Rejection (gaya manual user): tren 4H + retest fib golden 15m + candle rejection, exit RSI-flip ─
const RR_EMA_FAST     = 50;       // EMA cepat 4H (tren)
const RR_EMA_SLOW     = 200;      // EMA lambat 4H (tren)
const RR_PIVOT_L      = 5;        // fractal pivot kiri (swing 15m SIGNIFIKAN, bukan tiap wiggle)
const RR_PIVOT_R      = 5;        // fractal pivot kanan (konfirmasi)
const RR_FIB_MIN      = 0.618;    // golden zone (retrace dangkal)
const RR_FIB_MAX      = 0.786;    // golden zone (retrace dalam)
const RR_RSI_PERIOD   = 14;       // RSI 15m (exit)
const RR_RSI_OB       = 70;       // exit LONG saat RSI ≥ 70 (overbought)
const RR_RSI_OS       = 30;       // exit SHORT saat RSI ≤ 30 (oversold)
const RR_SL_BUFFER    = 0.001;    // SL 0,1% di luar wick candle rejection
const RR_ZONE_TIMEOUT = 96;       // bar 15m menunggu pullback ke zona (≈24 jam)
const RR_MAX_HOLD     = 384;      // hold maksimum (≈4 hari) sebelum exit paksa

// ─── EMA50 Impulse Cross (4H): candle impulsif (body besar + volume spike) yg menembus
// EMA50 → entry searah cross. Exit saat close balik melintasi EMA50 (tren patah). ──────
const EMA_IMP_PERIOD     = 50;    // EMA 4H
const EMA_IMP_ATR_PERIOD = 14;
const EMA_IMP_BODY_ATR   = 1.0;   // body candle cross ≥ 1×ATR = impulsif
const EMA_IMP_VOL_MULT   = 1.5;   // volume ≥ 1.5× rata-rata = spike (konfirmasi)
const EMA_IMP_VOL_SMA    = 20;    // periode rata-rata volume
const EMA_IMP_SL_ATR     = 2.0;   // SL = 2×ATR (disaster stop)
const EMA_IMP_MAX_HOLD   = 180;   // hold maksimum (≈30 hari 4H)
const EMA_IMP_TRAIL_ATR  = 3.0;   // varian trail: chandelier 3×ATR (biarkan winner lari)
const EMA_IMP_TP_ATR     = 25.0;  // varian trail: TP cap jauh (trailing yg dominan)

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
    const bars1d  = days + 60;

    console.log(`\n🔬 ${symbol} | ${days}d | fetching data...`);
    const t0 = Date.now();
    let c5m: Candle[], c15m: Candle[], c1h: Candle[], c4h: Candle[], c1d: Candle[];
    try {
        [c5m, c15m, c1h, c4h, c1d] = await Promise.all([
            fetchCandles(symbol, '5m',  bars5m),
            fetchCandles(symbol, '15m', bars15m),
            fetchCandles(symbol, '1H',  bars1h),
            fetchCandles(symbol, '4H',  bars4h),
            fetchCandles(symbol, '1D',  bars1d),
        ]);
    } catch (e: any) {
        console.error(`❌ ${symbol}: fetch failed — ${e.message}`);
        return [];
    }
    console.log(`   Got ${c5m.length}×5m ${c15m.length}×15m ${c1h.length}×1H ${c4h.length}×4H ${c1d.length}×1D in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (c5m.length < WINDOW_BARS + 10 || c1h.length < WINDOW_BARS + 5) {
        console.warn(`⚠️  ${symbol}: insufficient data — skipping`);
        return [];
    }

    const strategy = getStrategyInstance(symbol);
    const trades: Trade[] = [];
    let lastProgress = -1;

    const isRsiFibo = strategy.name === 'rsi_fibo';
    // Map untuk melacak posisi aktif per symbol (proteksi overlapping)
    const activePositions: Set<string> = new Set();

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

            if (activePositions.has(symbol)) continue;

            // Hitung RSI 4H dari data historis (bukan live API)
            const closes4h = c4h.filter(c => c.ts <= current4hCandle.ts).slice(-(RSI_PERIOD + 5)).map(c => c.close);
            if (closes4h.length < RSI_PERIOD + 1) continue;
            const rsi4h = calculateRSI(closes4h, RSI_PERIOD);

            const { open: o4h, high: h4h, low: l4h, close: c4hClose } = current4hCandle;
            const upperWick4h = h4h - Math.max(c4hClose, o4h);
            const lowerWick4h = Math.min(c4hClose, o4h) - l4h;

            let trigSide: 'LONG' | 'SHORT';
            let fibo786: number;
            if (rsi4h > 70 && upperWick4h > lowerWick4h) {
                trigSide = 'SHORT';
                fibo786 = h4h - (h4h - l4h) * 0.786;
            } else if (rsi4h < 30 && lowerWick4h > upperWick4h) {
                trigSide = 'LONG';
                fibo786 = l4h + (h4h - l4h) * 0.786;
            } else {
                continue;
            }

            // Fix 1: Daily RSI trend filter using historical 1D candles
            const dailyCloses = c1d.filter(c => c.ts <= current4hCandle.ts).slice(-(RSI_PERIOD + 5)).map(c => c.close);
            if (dailyCloses.length >= RSI_PERIOD + 1) {
                const dailyRsi = calculateRSI(dailyCloses, RSI_PERIOD);
                if (trigSide === 'LONG' && dailyRsi < DAILY_RSI_LONG_MIN) continue;
                if (trigSide === 'SHORT' && dailyRsi > DAILY_RSI_SHORT_MAX) continue;
            }

            const triggerContext = { side: trigSide, fibo786, high4h: h4h, low4h: l4h, rsiAtTrigger: rsi4h };

            const entryPrice = triggerContext.fibo786;
            const side = triggerContext.side;
            const slPrice = side === 'SHORT' ? entryPrice * 1.05 : entryPrice * 0.95;
            
            const future15m = c15m.filter(c => c.ts > current4hCandle.ts);
            let fillIdx = -1;
            for (let j = 0; j < future15m.length; j++) {
                const isFill = side === 'SHORT'
                    ? future15m[j].low <= entryPrice    // SHORT: tunggu harga turun ke entry pullback
                    : future15m[j].high >= entryPrice;  // LONG: tunggu harga naik ke entry breakout
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

            // Tandai posisi aktif
            activePositions.add(symbol);

            for (let j = fillIdx + 1; j < future15m.length; j++) {
                // Hard SL (5%)
                const slHit = side === 'SHORT'
                    ? future15m[j].high >= slPrice
                    : future15m[j].low <= slPrice;
                
                if (slHit) {
                    exitPrice = slPrice;
                    exitReason = 'SL';
                    exitIdx = j;
                    break;
                }

                // TP: RSI 4H reaches opposite extreme
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
                            exitReason = 'TP_RSI';
                            exitIdx = j;
                            break;
                        }
                    }
                }
            }

            if (exitIdx === -1) {
                exitPrice = future15m[future15m.length - 1].close;
                exitReason = 'OPEN';
            }

            // Hapus posisi aktif setelah exit
            activePositions.delete(symbol);

            const finalR = side === 'SHORT'
                ? (entryPrice - exitPrice) / (slPrice - entryPrice)
                : (exitPrice - entryPrice) / (entryPrice - slPrice);

            trades.push({
                symbol,
                entryTs: fillCandle.ts,
                exitTs: exitIdx >= 0 ? future15m[exitIdx].ts : null,
                side,
                entryPrice,
                slPrice,
                tpLevels: [exitPrice],
                tpHit: [exitReason === 'TP_RSI'],
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
    applyTradingFees(trades); // potong fee round-trip → metrik & balance jadi net fee
    printReport(symbol, days, trades, verbose);
    if (trades.length > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        saveTradesToCsv(trades, `trades_${symbol.replace(/[^a-zA-Z0-9]/g, '_')}_${days}d_${ts}.csv`);
    }
    return trades;
}

// ─── Scalp Bollinger Band Mean-Reversion backtest ─────────────────────────
// Logika: di timeframe 5m, candle yang wick-nya menembus Bollinger Band
// (period 20, 2 stdev) sambil RSI(14) di zona ekstrem dan close kembali
// rejection ke arah tengah band → entry MARKET di close candle itu.
// SL = sedikit di luar wick candle entry, TP = fixed R-multiple (RR 1.5).
function precomputeRSI(candles: Candle[], period: number): (number | null)[] {
    const n = candles.length;
    const rsiArr: (number | null)[] = new Array(n).fill(null);
    if (n < period + 1) return rsiArr;

    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const change = candles[i].close - candles[i - 1].close;
        if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
    }
    avgGain /= period; avgLoss /= period;
    rsiArr[period] = 100 - (100 / (1 + avgGain / (avgLoss === 0 ? 0.001 : avgLoss)));

    for (let i = period + 1; i < n; i++) {
        const change = candles[i].close - candles[i - 1].close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        rsiArr[i] = 100 - (100 / (1 + avgGain / (avgLoss === 0 ? 0.001 : avgLoss)));
    }
    return rsiArr;
}

function precomputeEMA(candles: Candle[], period: number): (number | null)[] {
    const n = candles.length;
    const ema: (number | null)[] = new Array(n).fill(null);
    if (n < period) return ema;
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += candles[i].close;
    ema[period - 1] = sum / period;
    for (let i = period; i < n; i++) {
        ema[i] = candles[i].close * k + (ema[i - 1] as number) * (1 - k);
    }
    return ema;
}

function precomputeBollingerBands(
    candles: Candle[], period: number, stdDevMult: number
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
    const n = candles.length;
    const upper: (number | null)[] = new Array(n).fill(null);
    const middle: (number | null)[] = new Array(n).fill(null);
    const lower: (number | null)[] = new Array(n).fill(null);

    for (let i = period - 1; i < n; i++) {
        let sum = 0;
        for (let k = i - period + 1; k <= i; k++) sum += candles[k].close;
        const mean = sum / period;
        let variance = 0;
        for (let k = i - period + 1; k <= i; k++) variance += (candles[k].close - mean) ** 2;
        const std = Math.sqrt(variance / period);
        middle[i] = mean;
        upper[i] = mean + stdDevMult * std;
        lower[i] = mean - stdDevMult * std;
    }
    return { upper, middle, lower };
}

// Potong fee round-trip dari finalR tiap trade (in-place). Dipanggil tiap strategi
// sebelum printReport supaya SEMUA metrik (win rate, expectancy, balance) sudah net fee.
// Win/loss diklasifikasi ulang otomatis lewat finalR yg sudah dikurangi fee.
function applyTradingFees(trades: Trade[]): void {
    if (FEE_PER_SIDE <= 0) return;
    for (const t of trades) {
        const rDist = Math.abs(t.entryPrice - t.slPrice);
        if (rDist <= 0) continue;
        const feeR = 2 * FEE_PER_SIDE * t.entryPrice / rDist;
        t.finalR -= feeR;
    }
}

function simulateFixedTpSlTrade(
    side: 'LONG' | 'SHORT',
    entry: number, sl: number, tp: number,
    future: Candle[]
): { exitIdx: number; finalR: number; endReason: EndReason } {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    const rMultiple = risk > 0 ? reward / risk : 0;
    for (let k = 0; k < future.length; k++) {
        const c = future[k];
        const slHit = side === 'LONG' ? c.low <= sl : c.high >= sl;
        const tpHit = side === 'LONG' ? c.high >= tp : c.low <= tp;
        if (slHit) return { exitIdx: k, finalR: -1, endReason: 'SL' };
        if (tpHit) return { exitIdx: k, finalR: rMultiple, endReason: 'TP_FULL' };
    }
    return { exitIdx: -1, finalR: 0, endReason: 'OPEN' };
}

// Exit dgn trailing stop ATR: SL awal tetap, tapi begitu harga bergerak menguntungkan,
// stop ikut naik di (extreme sejak entry − trail×ATR). Winner dibiarkan lari (edge ada di
// ekor), TP cap cuma batas atas pengaman. finalR variabel sesuai sejauh apa trend berjalan.
function simulateTrailingTrade(
    side: 'LONG' | 'SHORT',
    entry: number, sl: number, tp: number, atr: number, trailMult: number,
    future: Candle[]
): { exitIdx: number; finalR: number; endReason: EndReason } {
    const risk = Math.abs(entry - sl);
    if (risk <= 0) return { exitIdx: -1, finalR: 0, endReason: 'OPEN' };
    let stop = sl;
    let extreme = entry; // harga terbaik yg dicapai sejak entry (high utk LONG, low utk SHORT)

    for (let k = 0; k < future.length; k++) {
        const c = future[k];
        if (side === 'LONG') {
            // 1) cek stop dulu (konservatif: low bisa kena sebelum high)
            if (c.low <= stop) {
                const r = (stop - entry) / risk;
                return { exitIdx: k, finalR: r, endReason: stop >= entry ? 'TRAIL' : 'SL' };
            }
            if (c.high >= tp) return { exitIdx: k, finalR: (tp - entry) / risk, endReason: 'TP_FULL' };
            // 2) update extreme & geser trailing stop naik (tidak pernah turun)
            if (c.high > extreme) extreme = c.high;
            stop = Math.max(stop, extreme - trailMult * atr);
        } else {
            if (c.high >= stop) {
                const r = (entry - stop) / risk;
                return { exitIdx: k, finalR: r, endReason: stop <= entry ? 'TRAIL' : 'SL' };
            }
            if (c.low <= tp) return { exitIdx: k, finalR: (entry - tp) / risk, endReason: 'TP_FULL' };
            if (c.low < extreme) extreme = c.low;
            stop = Math.min(stop, extreme + trailMult * atr);
        }
    }
    return { exitIdx: -1, finalR: 0, endReason: 'OPEN' };
}

// Pyramiding (Turtle): tambah 1 unit penuh tiap harga maju stepMult×ATR searah tren, sampai
// maxUnits. Semua unit berbagi 1 trailing stop (chandelier). finalR = jumlah R seluruh unit
// (basis = risk unit awal) → ekor sangat gemuk di tren besar. CATATAN: tiap unit ukuran penuh,
// jadi posisi penuh = maxUnits× margin; balance sim tak menegakkan batas margin → upside optimistis.
function simulatePyramidTrade(
    side: 'LONG' | 'SHORT',
    entry: number, baseRisk: number, atr: number,
    stepMult: number, trailMult: number, maxUnits: number,
    future: Candle[]
): { exitIdx: number; finalR: number; endReason: EndReason; units: number } {
    if (baseRisk <= 0) return { exitIdx: -1, finalR: 0, endReason: 'OPEN', units: 1 };
    const entries: number[] = [entry];
    let stop = side === 'LONG' ? entry - baseRisk : entry + baseRisk;
    let extreme = entry;
    let nextAdd = side === 'LONG' ? entry + stepMult * atr : entry - stepMult * atr;

    const aggR = (px: number): number =>
        entries.reduce((s, e) => s + (side === 'LONG' ? (px - e) : (e - px)) / baseRisk, 0);

    for (let k = 0; k < future.length; k++) {
        const c = future[k];
        if (side === 'LONG') {
            if (c.low <= stop) return { exitIdx: k, finalR: aggR(stop), endReason: aggR(stop) >= 0 ? 'TRAIL' : 'SL', units: entries.length };
            while (entries.length < maxUnits && c.high >= nextAdd) { entries.push(nextAdd); nextAdd += stepMult * atr; }
            if (c.high > extreme) extreme = c.high;
            stop = Math.max(stop, extreme - trailMult * atr);
        } else {
            if (c.high >= stop) return { exitIdx: k, finalR: aggR(stop), endReason: aggR(stop) >= 0 ? 'TRAIL' : 'SL', units: entries.length };
            while (entries.length < maxUnits && c.low <= nextAdd) { entries.push(nextAdd); nextAdd -= stepMult * atr; }
            if (c.low < extreme) extreme = c.low;
            stop = Math.min(stop, extreme + trailMult * atr);
        }
    }
    const last = future[future.length - 1].close;
    return { exitIdx: -1, finalR: aggR(last), endReason: 'OPEN', units: entries.length };
}

async function runScalpBBBacktest(symbol: string, days: number, verbose: boolean = true): Promise<Trade[]> {
    const bars5m = days * 24 * 12 + WINDOW_BARS;
    const bars4h = days * 6 + SCALP_EMA_PERIOD + WINDOW_BARS;

    console.log(`\n🔬 ${symbol} | ${days}d | fetching data (scalp_bb)...`);
    const t0 = Date.now();
    let c5m: Candle[], c4h: Candle[];
    try {
        [c5m, c4h] = await Promise.all([
            fetchCandles(symbol, '5m', bars5m),
            fetchCandles(symbol, '4H', bars4h),
        ]);
    } catch (e: any) {
        console.error(`❌ ${symbol}: fetch failed — ${e.message}`);
        return [];
    }
    console.log(`   Got ${c5m.length}×5m ${c4h.length}×4H in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (c5m.length < SCALP_BB_PERIOD + SCALP_RSI_PERIOD + 10 || c4h.length < SCALP_EMA_PERIOD + 1) {
        console.warn(`⚠️  ${symbol}: insufficient data — skipping`);
        return [];
    }

    const { upper, middle, lower } = precomputeBollingerBands(c5m, SCALP_BB_PERIOD, SCALP_BB_STDDEV);
    const rsi = precomputeRSI(c5m, SCALP_RSI_PERIOD);
    const ema4h = precomputeEMA(c4h, SCALP_EMA_PERIOD);

    const trades: Trade[] = [];
    const startIdx = Math.max(SCALP_BB_PERIOD, SCALP_RSI_PERIOD);

    let trendIdx = 0; // pointer ke c4h: candle 4H terakhir yg sudah closed sebelum candle 5m saat ini

    for (let i = startIdx; i < c5m.length; i++) {
        const candle = c5m[i];

        while (trendIdx + 1 < c4h.length && c4h[trendIdx + 1].ts <= candle.ts) trendIdx++;
        const trendEma = ema4h[trendIdx];

        const up = upper[i], mid = middle[i], low = lower[i], r = rsi[i];
        if (up === null || mid === null || low === null || r === null || trendEma === null) continue;

        let side: 'LONG' | 'SHORT' | null = null;
        if (candle.low <= low && r <= SCALP_RSI_OVERSOLD && candle.close > candle.open && candle.close > low && candle.close > trendEma) {
            side = 'LONG';
        } else if (candle.high >= up && r >= SCALP_RSI_OVERBOUGHT && candle.close < candle.open && candle.close < up && candle.close < trendEma) {
            side = 'SHORT';
        }
        if (!side) continue;

        const entry = candle.close;
        const sl = side === 'LONG'
            ? candle.low * (1 - SCALP_SL_BUFFER)
            : candle.high * (1 + SCALP_SL_BUFFER);
        const risk = Math.abs(entry - sl);
        if (risk <= 0) continue;
        const tp = side === 'LONG' ? entry + risk * SCALP_RR : entry - risk * SCALP_RR;

        const future = c5m.slice(i + 1);
        const sim = simulateFixedTpSlTrade(side, entry, sl, tp, future);

        trades.push({
            symbol,
            entryTs: candle.ts,
            exitTs: sim.exitIdx >= 0 ? future[sim.exitIdx].ts : null,
            side,
            entryPrice: entry,
            slPrice: sl,
            tpLevels: [tp],
            tpHit: [sim.endReason === 'TP_FULL'],
            breakevenMoved: false,
            finalR: sim.finalR,
            barsHeld: sim.exitIdx >= 0 ? sim.exitIdx + 1 : future.length,
            endReason: sim.endReason,
            confluence: [`BB=${low.toFixed(4)}-${up.toFixed(4)}`, `RSI=${r.toFixed(1)}`]
        });

        if (sim.exitIdx >= 0) i += sim.exitIdx + 1; else i = c5m.length;
    }

    process.stdout.write('                    \r');
    console.log(`   📊 ${symbol}: ${trades.length} signals generated`);
    applyTradingFees(trades); // potong fee round-trip → metrik & balance jadi net fee
    printReport(symbol, days, trades, verbose);
    if (trades.length > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        saveTradesToCsv(trades, `trades_${symbol.replace(/[^a-zA-Z0-9]/g, '_')}_${days}d_${ts}.csv`);
    }
    return trades;
}

// ─── Multi-Timeframe VWAP strategy (H4 trend/ATR + M15 VWAP/RSI/BB entry) ──

// Step 2 (risk management): ATR Wilder-smoothed, dipakai utk SL/TP dinamis di H4.
function precomputeATR(candles: Candle[], period: number): (number | null)[] {
    const n = candles.length;
    const atr: (number | null)[] = new Array(n).fill(null);
    if (n <= period) return atr;

    const tr: number[] = new Array(n).fill(0);
    for (let i = 1; i < n; i++) {
        const highLow = candles[i].high - candles[i].low;
        const highPrevClose = Math.abs(candles[i].high - candles[i - 1].close);
        const lowPrevClose = Math.abs(candles[i].low - candles[i - 1].close);
        tr[i] = Math.max(highLow, highPrevClose, lowPrevClose);
    }

    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr[i];
    atr[period] = sum / period;
    for (let i = period + 1; i < n; i++) {
        atr[i] = ((atr[i - 1] as number) * (period - 1) + tr[i]) / period;
    }
    return atr;
}

// Step 4 (macro-economic kill-switch): placeholder.
// Saat ini selalu false — nantinya bisa diisi integrasi kalender ekonomi/news feed
// (misal: cek event high-impact dalam X menit ke depan lalu return true).
function check_macro_killswitch(): boolean {
    return false;
}

// Trend Pullback-Continuation: tren H4 (EMA50/200) menentukan arah, entry saat harga
// reclaim EMA50 dgn momentum (pullback selesai), SL/TP lebar berbasis ATR(H4). Jarang,
// presisi, target besar → kebal fee. (Dulu "mtf_vwap"; entry VWAP/BB diganti reclaim.)
async function runMtfVwapBacktest(symbol: string, days: number, verbose: boolean = true): Promise<Trade[]> {
    const bars15m = days * 24 * 4 + WINDOW_BARS;
    const bars4h = days * 6 + MTF_EMA_SLOW + WINDOW_BARS;

    console.log(`\n🔬 ${symbol} | ${days}d | fetching data (trend-pullback)...`);
    const t0 = Date.now();
    let c15m: Candle[], c4h: Candle[];
    try {
        [c15m, c4h] = await Promise.all([
            fetchCandles(symbol, '15m', bars15m),
            fetchCandles(symbol, '4H', bars4h),
        ]);
    } catch (e: any) {
        console.error(`❌ ${symbol}: fetch failed — ${e.message}`);
        return [];
    }
    console.log(`   Got ${c15m.length}×15m ${c4h.length}×4H in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (c15m.length < 50 || c4h.length < MTF_EMA_SLOW + MTF_ATR_PERIOD + 1) {
        console.warn(`⚠️  ${symbol}: insufficient data — skipping`);
        return [];
    }

    // ── Step 1: Trend Filter (H4) — EMA50 & EMA200 ──
    const ema50_4h = precomputeEMA(c4h, MTF_EMA_FAST);
    const ema200_4h = precomputeEMA(c4h, MTF_EMA_SLOW);
    // ── Step 2: Risk Management (H4) — ATR(14) utk SL/TP dinamis ──
    const atr4h = precomputeATR(c4h, MTF_ATR_PERIOD);

    const trades: Trade[] = [];
    const startIdx = 1;

    let trendIdx = 0; // pointer ke c4h: candle H4 terakhir yg sudah closed sebelum candle M15 saat ini
    let standbyLogged = false;

    for (let i = startIdx; i < c15m.length; i++) {
        const candle = c15m[i];
        const prev = c15m[i - 1];

        // ── Step 4: Macro-economic kill-switch — pause semua entry baru ──
        if (check_macro_killswitch()) {
            if (!standbyLogged) {
                console.log(`   ⏸  ${symbol}: Standby due to Macro Events`);
                standbyLogged = true;
            }
            continue;
        }
        standbyLogged = false;

        // ── Step 1: Trend Filter (H4) — arah tren dari stack EMA50/EMA200 ──
        while (trendIdx + 1 < c4h.length && c4h[trendIdx + 1].ts <= candle.ts) trendIdx++;
        const ema50 = ema50_4h[trendIdx];
        const ema200 = ema200_4h[trendIdx];
        const atr = atr4h[trendIdx];
        if (ema50 === null || ema200 === null || atr === null) continue;

        const bullTrend = ema50 > ema200; // tren naik
        const bearTrend = ema50 < ema200; // tren turun
        if (!bullTrend && !bearTrend) continue;

        // ── Step 3: Entry Trigger — Pullback-Continuation ke EMA50(H4) ──
        // Idenya: di tren kuat, harga mundur ke "zona value" (EMA50) lalu lanjut.
        // LONG: tren naik, bar lalu sempat turun ke/bawah EMA50 (pullback), bar ini
        //       close balik DI ATAS EMA50 dgn candle bullish (konfirmasi lanjut tren).
        // SHORT: mirror. Reclaim EMA50 ini jarang & presisi → invalid sedikit, TP lebar.
        let side: 'LONG' | 'SHORT' | null = null;
        if (bullTrend && prev.close <= ema50 && candle.close > ema50 && candle.close > candle.open) {
            side = 'LONG';
        } else if (bearTrend && prev.close >= ema50 && candle.close < ema50 && candle.close < candle.open) {
            side = 'SHORT';
        }
        if (!side) continue;

        // ── Step 2: Risk Management — SL 1.5×ATR, TP 3×ATR (H4) ──
        // Stop lebar → feeR ~0.05R (fee nyaris tak terasa), TP 2× lebih jauh dari SL.
        const entry = candle.close;
        const sl = side === 'LONG' ? entry - MTF_SL_ATR_MULT * atr : entry + MTF_SL_ATR_MULT * atr;
        const tp = side === 'LONG' ? entry + MTF_TP_ATR_MULT * atr : entry - MTF_TP_ATR_MULT * atr;
        const risk = Math.abs(entry - sl);
        if (risk <= 0) continue;

        const future = c15m.slice(i + 1);
        const sim = simulateTrailingTrade(side, entry, sl, tp, atr, MTF_TRAIL_ATR_MULT, future);

        trades.push({
            symbol,
            entryTs: candle.ts,
            exitTs: sim.exitIdx >= 0 ? future[sim.exitIdx].ts : null,
            side,
            entryPrice: entry,
            slPrice: sl,
            tpLevels: [tp],
            tpHit: [sim.endReason === 'TP_FULL' || sim.endReason === 'TRAIL'],
            breakevenMoved: false,
            finalR: sim.finalR,
            barsHeld: sim.exitIdx >= 0 ? sim.exitIdx + 1 : future.length,
            endReason: sim.endReason,
            confluence: [`H4=${bullTrend ? 'BULL' : 'BEAR'}`, `EMA50=${ema50.toFixed(4)}`, `ATR=${atr.toFixed(4)}`]
        });

        if (sim.exitIdx >= 0) i += sim.exitIdx + 1; else i = c15m.length;
    }

    process.stdout.write('                    \r');
    console.log(`   📊 ${symbol}: ${trades.length} signals generated`);
    applyTradingFees(trades); // potong fee round-trip → metrik & balance jadi net fee
    printReport(symbol, days, trades, verbose);
    if (trades.length > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        saveTradesToCsv(trades, `trades_${symbol.replace(/[^a-zA-Z0-9]/g, '_')}_${days}d_${ts}.csv`);
    }
    return trades;
}

// Donchian channel: upper[i] = high tertinggi N candle SEBELUM i, lower[i] = low terendah.
// Window mundur (tidak termasuk candle i) supaya bebas look-ahead — breakout dibanding
// channel periode sebelumnya.
function precomputeDonchian(candles: Candle[], period: number): { upper: (number | null)[]; lower: (number | null)[] } {
    const n = candles.length;
    const upper: (number | null)[] = new Array(n).fill(null);
    const lower: (number | null)[] = new Array(n).fill(null);
    for (let i = period; i < n; i++) {
        let hi = -Infinity, lo = Infinity;
        for (let k = i - period; k < i; k++) {
            if (candles[k].high > hi) hi = candles[k].high;
            if (candles[k].low < lo) lo = candles[k].low;
        }
        upper[i] = hi;
        lower[i] = lo;
    }
    return { upper, lower };
}

// Donchian Breakout trend-following (4H, gaya Turtle). Entry saat close menembus channel
// 120-bar (≈20 hari), SL 2×ATR, exit via chandelier trailing 3×ATR. Jarang, tahan
// berhari-hari, TP raksasa → fee tak relevan. Long & short.
async function runDonchianBacktest(
    symbol: string, days: number, verbose: boolean = true,
    channel: number = DON_CHANNEL, trailMult: number = DON_TRAIL_ATR_MULT,
    pyramid: boolean = false
): Promise<Trade[]> {
    const bars4h = days * 6 + channel + DON_ATR_PERIOD + WINDOW_BARS;

    console.log(`\n🔬 ${symbol} | ${days}d | fetching data (donchian 4H)...`);
    const t0 = Date.now();
    let c4h: Candle[];
    try {
        c4h = await fetchCandles(symbol, '4H', bars4h);
    } catch (e: any) {
        console.error(`❌ ${symbol}: fetch failed — ${e.message}`);
        return [];
    }
    console.log(`   Got ${c4h.length}×4H in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    if (c4h.length < channel + DON_ATR_PERIOD + 5) {
        console.warn(`⚠️  ${symbol}: insufficient data — skipping`);
        return [];
    }

    const { upper, lower } = precomputeDonchian(c4h, channel);
    const atr4h = precomputeATR(c4h, DON_ATR_PERIOD);

    const trades: Trade[] = [];
    const startIdx = channel + DON_ATR_PERIOD;

    for (let i = startIdx; i < c4h.length; i++) {
        const candle = c4h[i];
        const chUp = upper[i], chLow = lower[i], atr = atr4h[i];
        if (chUp === null || chLow === null || atr === null) continue;

        // Breakout: close 4H tembus channel 120-bar sebelumnya. Itu sendiri sinyal tren.
        let side: 'LONG' | 'SHORT' | null = null;
        if (candle.close > chUp) side = 'LONG';
        else if (candle.close < chLow) side = 'SHORT';
        if (!side) continue;

        const entry = candle.close;
        const sl = side === 'LONG' ? entry - DON_SL_ATR_MULT * atr : entry + DON_SL_ATR_MULT * atr;
        const tp = side === 'LONG' ? entry + DON_TP_ATR_MULT * atr : entry - DON_TP_ATR_MULT * atr;
        const risk = Math.abs(entry - sl);
        if (risk <= 0) continue;

        const future = c4h.slice(i + 1);
        let sim: { exitIdx: number; finalR: number; endReason: EndReason };
        let units = 1;
        if (pyramid) {
            const p = simulatePyramidTrade(side, entry, risk, atr, PYRAMID_STEP_ATR, trailMult, PYRAMID_MAX, future);
            sim = { exitIdx: p.exitIdx, finalR: p.finalR, endReason: p.endReason };
            units = p.units;
        } else {
            sim = simulateTrailingTrade(side, entry, sl, tp, atr, trailMult, future);
        }

        trades.push({
            symbol,
            entryTs: candle.ts,
            exitTs: sim.exitIdx >= 0 ? future[sim.exitIdx].ts : null,
            side,
            entryPrice: entry,
            slPrice: sl,
            tpLevels: [tp],
            tpHit: [sim.endReason === 'TP_FULL' || sim.endReason === 'TRAIL'],
            breakevenMoved: false,
            finalR: sim.finalR,
            barsHeld: sim.exitIdx >= 0 ? sim.exitIdx + 1 : future.length,
            endReason: sim.endReason,
            confluence: [`DON=${chLow.toFixed(4)}-${chUp.toFixed(4)}`, `ATR=${atr.toFixed(4)}`, `units=${units}`]
        });

        if (sim.exitIdx >= 0) i += sim.exitIdx + 1; else i = c4h.length;
    }

    process.stdout.write('                    \r');
    console.log(`   📊 ${symbol}: ${trades.length} signals generated`);
    applyTradingFees(trades); // fee round-trip → metrik net fee (di sini efeknya ~nol)
    printReport(symbol, days, trades, verbose);
    if (trades.length > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        saveTradesToCsv(trades, `trades_${symbol.replace(/[^a-zA-Z0-9]/g, '_')}_${days}d_${ts}.csv`);
    }
    return trades;
}

// Exit ala user "optimis": tahan posisi sampai RSI(15m) balik ke ekstrem berlawanan
// (LONG→overbought, SHORT→oversold), atau kena SL, atau timeout maxHold. finalR variabel.
function simulateRsiFlipExit(
    side: 'LONG' | 'SHORT', entry: number, sl: number,
    future: Candle[], rsiFuture: (number | null)[], maxHold: number
): { exitIdx: number; finalR: number; endReason: EndReason } {
    const risk = Math.abs(entry - sl);
    if (risk <= 0) return { exitIdx: -1, finalR: 0, endReason: 'OPEN' };
    const n = Math.min(future.length, maxHold);
    for (let k = 0; k < n; k++) {
        const c = future[k];
        const slHit = side === 'LONG' ? c.low <= sl : c.high >= sl;
        if (slHit) return { exitIdx: k, finalR: -1, endReason: 'SL' };
        const r = rsiFuture[k];
        if (r !== null) {
            if (side === 'LONG' && r >= RR_RSI_OB) return { exitIdx: k, finalR: (c.close - entry) / risk, endReason: 'TP_RSI' };
            if (side === 'SHORT' && r <= RR_RSI_OS) return { exitIdx: k, finalR: (entry - c.close) / risk, endReason: 'TP_RSI' };
        }
    }
    if (n <= 0) return { exitIdx: -1, finalR: 0, endReason: 'OPEN' };
    const last = future[n - 1];
    const r = side === 'LONG' ? (last.close - entry) / risk : (entry - last.close) / risk;
    return { exitIdx: n - 1, finalR: r, endReason: 'OPEN' };
}

// Retest-Rejection: tren H4 (EMA50/200) tentukan arah. Di 15m, deteksi impuls searah tren
// (swing low→high utk bull), tunggu pullback ke zona fib golden 0.618-0.786, masuk saat ada
// candle rejection. Exit via RSI-flip. Ini otomasi dari strategi manual user.
async function runRetestRejectBacktest(symbol: string, days: number, verbose: boolean = true): Promise<Trade[]> {
    const bars15m = days * 24 * 4 + WINDOW_BARS;
    const bars4h  = days * 6 + RR_EMA_SLOW + WINDOW_BARS;
    console.log(`\n🔬 ${symbol} | ${days}d | fetching data (retest-reject)...`);
    const t0 = Date.now();
    let c15m: Candle[], c4h: Candle[];
    try {
        [c15m, c4h] = await Promise.all([
            fetchCandles(symbol, '15m', bars15m),
            fetchCandles(symbol, '4H', bars4h),
        ]);
    } catch (e: any) { console.error(`❌ ${symbol}: fetch failed — ${e.message}`); return []; }
    console.log(`   Got ${c15m.length}×15m ${c4h.length}×4H in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (c15m.length < 100 || c4h.length < RR_EMA_SLOW + 5) { console.warn(`⚠️  ${symbol}: insufficient data — skipping`); return []; }

    const ema50 = precomputeEMA(c4h, RR_EMA_FAST);
    const ema200 = precomputeEMA(c4h, RR_EMA_SLOW);
    const rsi15 = precomputeRSI(c15m, RR_RSI_PERIOD);

    const isPivotHigh = (idx: number): boolean => {
        if (idx - RR_PIVOT_L < 0 || idx + RR_PIVOT_R >= c15m.length) return false;
        const v = c15m[idx].high;
        for (let k = idx - RR_PIVOT_L; k <= idx + RR_PIVOT_R; k++) if (k !== idx && c15m[k].high >= v) return false;
        return true;
    };
    const isPivotLow = (idx: number): boolean => {
        if (idx - RR_PIVOT_L < 0 || idx + RR_PIVOT_R >= c15m.length) return false;
        const v = c15m[idx].low;
        for (let k = idx - RR_PIVOT_L; k <= idx + RR_PIVOT_R; k++) if (k !== idx && c15m[k].low <= v) return false;
        return true;
    };

    const trades: Trade[] = [];
    let trendIdx = 0;
    let swingHigh: { price: number; idx: number } | null = null;
    let swingLow:  { price: number; idx: number } | null = null;

    for (let i = RR_PIVOT_L + RR_PIVOT_R; i < c15m.length; i++) {
        const pivIdx = i - RR_PIVOT_R; // pivot baru terkonfirmasi RR_PIVOT_R bar di belakang
        if (isPivotHigh(pivIdx)) swingHigh = { price: c15m[pivIdx].high, idx: pivIdx };
        if (isPivotLow(pivIdx))  swingLow  = { price: c15m[pivIdx].low,  idx: pivIdx };

        const candle = c15m[i];
        while (trendIdx + 1 < c4h.length && c4h[trendIdx + 1].ts <= candle.ts) trendIdx++;
        const ef = ema50[trendIdx], es = ema200[trendIdx];
        if (ef === null || es === null) continue;
        const bull = ef > es, bear = ef < es;

        let side: 'LONG' | 'SHORT' | null = null;
        let entry = 0, sl = 0;

        if (bull && swingLow && swingHigh && swingHigh.idx > swingLow.idx && swingHigh.price > swingLow.price
            && (i - swingHigh.idx) <= RR_ZONE_TIMEOUT) {
            // impuls naik A(low)→B(high); zona fib retrace turun
            const A = swingLow.price, B = swingHigh.price, range = B - A;
            const zoneHigh = B - RR_FIB_MIN * range; // retrace 0.618 (dangkal)
            const zoneLow  = B - RR_FIB_MAX * range; // retrace 0.786 (dalam)
            const enteredZone = candle.low <= zoneHigh;
            const rejection = candle.close > candle.open && candle.close >= zoneLow;
            // SL struktural: di bawah swing low (titik A impuls) — break = impuls invalid
            if (enteredZone && rejection) { side = 'LONG'; entry = candle.close; sl = A * (1 - RR_SL_BUFFER); }
        } else if (bear && swingHigh && swingLow && swingLow.idx > swingHigh.idx && swingLow.price < swingHigh.price
            && (i - swingLow.idx) <= RR_ZONE_TIMEOUT) {
            // impuls turun A(high)→B(low); zona fib retrace naik
            const A = swingHigh.price, B = swingLow.price, range = A - B;
            const zoneLow  = B + RR_FIB_MIN * range; // retrace 0.618 (dangkal)
            const zoneHigh = B + RR_FIB_MAX * range; // retrace 0.786 (dalam)
            const enteredZone = candle.high >= zoneLow;
            const rejection = candle.close < candle.open && candle.close <= zoneHigh;
            // SL struktural: di atas swing high (titik A impuls) — break = impuls invalid
            if (enteredZone && rejection) { side = 'SHORT'; entry = candle.close; sl = A * (1 + RR_SL_BUFFER); }
        }
        if (!side) continue;
        const risk = Math.abs(entry - sl);
        if (risk <= 0) continue;

        const future = c15m.slice(i + 1);
        const rsiFut = rsi15.slice(i + 1);
        const sim = simulateRsiFlipExit(side, entry, sl, future, rsiFut, RR_MAX_HOLD);

        trades.push({
            symbol, entryTs: candle.ts,
            exitTs: sim.exitIdx >= 0 ? future[sim.exitIdx].ts : null,
            side, entryPrice: entry, slPrice: sl,
            tpLevels: [entry], tpHit: [sim.endReason === 'TP_RSI'],
            breakevenMoved: false, finalR: sim.finalR,
            barsHeld: sim.exitIdx >= 0 ? sim.exitIdx + 1 : future.length,
            endReason: sim.endReason,
            confluence: [`4H=${bull ? 'BULL' : 'BEAR'}`, 'fib-golden-retest']
        });
        // reset impuls yg sudah dipakai biar tidak entry berulang dari swing yg sama
        if (side === 'LONG') swingHigh = null; else swingLow = null;
        if (sim.exitIdx >= 0) i += sim.exitIdx + 1;
    }

    process.stdout.write('                    \r');
    console.log(`   📊 ${symbol}: ${trades.length} signals generated`);
    applyTradingFees(trades);
    printReport(symbol, days, trades, verbose);
    if (trades.length > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        saveTradesToCsv(trades, `trades_${symbol.replace(/[^a-zA-Z0-9]/g, '_')}_${days}d_${ts}.csv`);
    }
    return trades;
}

// Exit utk EMA-impulse: tahan sampai close 4H balik melintasi EMA50 (tren patah), atau SL.
function simulateEmaCrossExit(
    side: 'LONG' | 'SHORT', entry: number, sl: number,
    future: Candle[], emaFuture: (number | null)[], maxHold: number
): { exitIdx: number; finalR: number; endReason: EndReason } {
    const risk = Math.abs(entry - sl);
    if (risk <= 0) return { exitIdx: -1, finalR: 0, endReason: 'OPEN' };
    const n = Math.min(future.length, maxHold);
    for (let k = 0; k < n; k++) {
        const c = future[k];
        const slHit = side === 'LONG' ? c.low <= sl : c.high >= sl;
        if (slHit) return { exitIdx: k, finalR: -1, endReason: 'SL' };
        const e = emaFuture[k];
        if (e !== null) {
            if (side === 'LONG' && c.close < e) return { exitIdx: k, finalR: (c.close - entry) / risk, endReason: 'TRAIL' };
            if (side === 'SHORT' && c.close > e) return { exitIdx: k, finalR: (entry - c.close) / risk, endReason: 'TRAIL' };
        }
    }
    if (n <= 0) return { exitIdx: -1, finalR: 0, endReason: 'OPEN' };
    const last = future[n - 1];
    const r = side === 'LONG' ? (last.close - entry) / risk : (entry - last.close) / risk;
    return { exitIdx: n - 1, finalR: r, endReason: 'OPEN' };
}

// EMA50 Impulse Cross (4H). Entry saat candle impulsif (body ≥ 1×ATR + volume ≥ 1.5×rata2)
// menembus EMA50; arah = arah cross. SL 2×ATR. Exit saat close balik melintasi EMA50.
async function runEmaImpulseBacktest(symbol: string, days: number, verbose: boolean = true, useTrailing: boolean = false): Promise<Trade[]> {
    const bars4h = days * 6 + EMA_IMP_PERIOD + EMA_IMP_VOL_SMA + WINDOW_BARS;
    console.log(`\n🔬 ${symbol} | ${days}d | fetching data (ema_impulse${useTrailing ? '+trail' : ''} 4H)...`);
    const t0 = Date.now();
    let c4h: Candle[];
    try { c4h = await fetchCandles(symbol, '4H', bars4h); }
    catch (e: any) { console.error(`❌ ${symbol}: fetch failed — ${e.message}`); return []; }
    console.log(`   Got ${c4h.length}×4H in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (c4h.length < EMA_IMP_PERIOD + EMA_IMP_VOL_SMA + 5) { console.warn(`⚠️  ${symbol}: insufficient data — skipping`); return []; }

    const ema50 = precomputeEMA(c4h, EMA_IMP_PERIOD);
    const atr4h = precomputeATR(c4h, EMA_IMP_ATR_PERIOD);
    // rata-rata volume bergerak (deteksi spike)
    const n = c4h.length;
    const volSMA: (number | null)[] = new Array(n).fill(null);
    let vsum = 0;
    for (let i = 0; i < n; i++) {
        vsum += c4h[i].volume;
        if (i >= EMA_IMP_VOL_SMA) vsum -= c4h[i - EMA_IMP_VOL_SMA].volume;
        if (i >= EMA_IMP_VOL_SMA - 1) volSMA[i] = vsum / EMA_IMP_VOL_SMA;
    }

    const trades: Trade[] = [];
    const startIdx = Math.max(EMA_IMP_PERIOD, EMA_IMP_VOL_SMA) + 1;

    for (let i = startIdx; i < n; i++) {
        const c = c4h[i], e = ema50[i], ePrev = ema50[i - 1], a = atr4h[i], vs = volSMA[i];
        if (e === null || ePrev === null || a === null || vs === null) continue;

        const crossUp = c.close > e && c4h[i - 1].close <= ePrev;
        const crossDn = c.close < e && c4h[i - 1].close >= ePrev;
        const body = Math.abs(c.close - c.open);
        const impulsive = body >= EMA_IMP_BODY_ATR * a && c.volume >= EMA_IMP_VOL_MULT * vs;

        const side: 'LONG' | 'SHORT' | null = (crossUp && impulsive) ? 'LONG' : (crossDn && impulsive) ? 'SHORT' : null;
        if (!side) continue;

        const entry = c.close;
        const sl = side === 'LONG' ? entry - EMA_IMP_SL_ATR * a : entry + EMA_IMP_SL_ATR * a;
        const risk = Math.abs(entry - sl);
        if (risk <= 0) continue;

        const future = c4h.slice(i + 1);
        const emaFut = ema50.slice(i + 1);
        const sim = useTrailing
            ? simulateTrailingTrade(side, entry, sl, side === 'LONG' ? entry + EMA_IMP_TP_ATR * a : entry - EMA_IMP_TP_ATR * a, a, EMA_IMP_TRAIL_ATR, future)
            : simulateEmaCrossExit(side, entry, sl, future, emaFut, EMA_IMP_MAX_HOLD);

        trades.push({
            symbol, entryTs: c.ts,
            exitTs: sim.exitIdx >= 0 ? future[sim.exitIdx].ts : null,
            side, entryPrice: entry, slPrice: sl,
            tpLevels: [entry], tpHit: [sim.finalR > 0],
            breakevenMoved: false, finalR: sim.finalR,
            barsHeld: sim.exitIdx >= 0 ? sim.exitIdx + 1 : future.length,
            endReason: sim.endReason,
            confluence: [`cross=${side === 'LONG' ? 'UP' : 'DN'}`, `body=${(body / a).toFixed(1)}×ATR`, `vol=${(c.volume / vs).toFixed(1)}×`]
        });
        if (sim.exitIdx >= 0) i += sim.exitIdx + 1;
    }

    process.stdout.write('                    \r');
    console.log(`   📊 ${symbol}: ${trades.length} signals generated`);
    applyTradingFees(trades);
    printReport(symbol, days, trades, verbose);
    if (trades.length > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        saveTradesToCsv(trades, `trades_${symbol.replace(/[^a-zA-Z0-9]/g, '_')}_${days}d_${ts}.csv`);
    }
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

function simulateBalance(
    trades: Trade[],
    maxConcurrent: number = Infinity,
    leverage: number = BACKTEST_LEVERAGE,
    marginPct: number = BACKTEST_MARGIN_PCT
): { finalBalance: number; peak: number; maxDdPct: number; maxDdUsdt: number; tradeCount: number } {
    const closed = trades.filter(t => t.exitTs !== null).sort((a, b) => a.entryTs - b.entryTs);
    let balance = BACKTEST_INITIAL_BALANCE, peak = BACKTEST_INITIAL_BALANCE;
    let maxDdPct = 0, maxDdUsdt = 0, count = 0;
    const openExits: number[] = [];
    for (const t of closed) {
        const stillOpen = openExits.filter(exitTs => exitTs > t.entryTs);
        openExits.length = 0; openExits.push(...stillOpen);
        if (openExits.length >= maxConcurrent) continue;
        const rDist = Math.abs(t.entryPrice - t.slPrice);
        if (rDist <= 0 || balance <= 0) continue;
        // Margin-based (match bot live): notional = saldo × MARGIN_PCT × leverage, qty = notional / entry.
        // pnl = R × jarak_SL × qty. Sizing ikut saldo → menang meng-compound.
        const qty = (balance * marginPct * leverage) / t.entryPrice;
        const pnl = t.finalR * rDist * qty;
        balance = Math.max(0, balance + pnl); count++;
        if (balance > peak) peak = balance;
        const ddUsdt = peak - balance;
        const ddPct = peak > 0 ? ddUsdt / peak : 0;
        if (ddUsdt > maxDdUsdt) maxDdUsdt = ddUsdt;
        if (ddPct > maxDdPct) maxDdPct = ddPct;
        openExits.push(t.exitTs!);
    }
    return { finalBalance: balance, peak, maxDdPct, maxDdUsdt, tradeCount: count };
}

function printReport(symbol: string, days: number, trades: Trade[], detailed: boolean = true): void {
    const counts: Record<EndReason, number> = {
        'TP_FULL': 0, 'TP1_BE_HOLD': 0, 'TP1_BE_STOP': 0, 'SL': 0, 'OPEN': 0, 'TP_RSI': 0, 'TRAIL': 0
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

    console.log(`\n📋 All trades (${trades.length}):`);
    console.log(`  ${'Entry (UTC)'.padEnd(17)} ${'Side'.padEnd(6)} ${'Entry'.padEnd(12)} ${'SL'.padEnd(12)} ${'Exit/TP'.padEnd(12)} ${'Exit (UTC)'.padEnd(17)} ${'R'.padEnd(8)} Reason`);
    console.log(`  ${'-'.repeat(100)}`);
    for (const t of trades) {
        const entryDate = new Date(t.entryTs).toISOString().slice(0, 16).replace('T', ' ');
        const exitDate  = t.exitTs ? new Date(t.exitTs).toISOString().slice(0, 16).replace('T', ' ') : 'open'.padEnd(16);
        const mark      = t.finalR > 0 ? '✅' : t.finalR < 0 ? '❌' : '➖';
        const rStr      = (t.finalR >= 0 ? '+' : '') + t.finalR.toFixed(3) + 'R';
        const exitPrice = t.tpLevels[0];
        console.log(`  ${entryDate} ${t.side.padEnd(6)} ${t.entryPrice.toFixed(4).padEnd(12)} ${t.slPrice.toFixed(4).padEnd(12)} ${exitPrice.toFixed(4).padEnd(12)} ${exitDate} ${mark} ${rStr.padEnd(9)} ${t.endReason}`);
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
    console.log(`  Fee model:             ${FEE_PER_SIDE > 0 ? `${(FEE_PER_SIDE * 100).toFixed(3)}%/side taker (NET of fees)` : 'OFF (gross)'}`);
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

    // Fix 2: compound balance simulation with max concurrent cap
    const sim = simulateBalance(allTrades, MAX_CONCURRENT_POSITIONS);
    const simPct = ((sim.finalBalance / BACKTEST_INITIAL_BALANCE - 1) * 100).toFixed(1);
    console.log(`\n  💹 Balance sim (${BACKTEST_INITIAL_BALANCE} USDT start, ${BACKTEST_MARGIN_PCT*100}% margin × ${BACKTEST_LEVERAGE}x, compounding, max ${MAX_CONCURRENT_POSITIONS} concurrent):`);
    console.log(`     Final balance:  ${sim.finalBalance.toFixed(2)} USDT  (${Number(simPct) >= 0 ? '+' : ''}${simPct}%)`);
    console.log(`     Peak balance:   ${sim.peak.toFixed(2)} USDT`);
    console.log(`     Max drawdown:   ${sim.maxDdUsdt.toFixed(2)} USDT (${(sim.maxDdPct * 100).toFixed(1)}%)`);
    console.log(`     Trades counted: ${sim.tradeCount}/${allTrades.length}`);

    // Leverage sweep: tradeoff growth vs drawdown dari trade-set yg sama (pilih leverage bot)
    console.log(`\n  ⚖️  Leverage sweep (${BACKTEST_MARGIN_PCT*100}% margin, compounding) — pilih sesuai toleransi DD:`);
    console.log(`     ${'Lev'.padEnd(6)} ${'Final'.padEnd(14)} ${'Growth'.padEnd(10)} ${'Max DD'.padEnd(8)}`);
    for (const lev of [1, 2, 3, 5, 10, 20]) {
        const s = simulateBalance(allTrades, MAX_CONCURRENT_POSITIONS, lev);
        const g = ((s.finalBalance / BACKTEST_INITIAL_BALANCE - 1) * 100);
        console.log(`     ${(lev + 'x').padEnd(6)} ${(s.finalBalance.toFixed(2) + ' USDT').padEnd(14)} ${((g >= 0 ? '+' : '') + g.toFixed(0) + '%').padEnd(10)} ${(s.maxDdPct * 100).toFixed(1) + '%'}`);
    }

    // Margin sweep di leverage TETAP (BACKTEST_LEVERAGE): DD diatur via ukuran posisi, bukan leverage.
    // notional = margin% × leverage; turunkan margin% → DD turun walau leverage tetap tinggi.
    console.log(`\n  🎯 Margin sweep @ ${BACKTEST_LEVERAGE}x tetap (turunkan ukuran posisi, leverage tak berubah):`);
    console.log(`     ${'Margin'.padEnd(8)} ${'Notional'.padEnd(10)} ${'Final'.padEnd(14)} ${'Growth'.padEnd(10)} ${'Max DD'.padEnd(8)}`);
    for (const m of [0.01, 0.015, 0.02, 0.03, 0.05, 0.10]) {
        const s = simulateBalance(allTrades, MAX_CONCURRENT_POSITIONS, BACKTEST_LEVERAGE, m);
        const g = ((s.finalBalance / BACKTEST_INITIAL_BALANCE - 1) * 100);
        const notional = (m * BACKTEST_LEVERAGE * 100).toFixed(0) + '%';
        console.log(`     ${((m * 100).toFixed(1) + '%').padEnd(8)} ${notional.padEnd(10)} ${(s.finalBalance.toFixed(2) + ' USDT').padEnd(14)} ${((g >= 0 ? '+' : '') + g.toFixed(0) + '%').padEnd(10)} ${(s.maxDdPct * 100).toFixed(1) + '%'}`);
    }

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

// ─── CSV export per-trade ──────────────────────────────────────────────────
function saveTradesToCsv(trades: Trade[], filename: string): void {
    const dir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);

    const header = 'no,entry_date,entry_time_utc,symbol,side,entry_price,sl_price,exit_price,exit_date,exit_time_utc,final_r,end_reason,bars_held,confluence';
    const rows = trades.map((t, idx) => {
        const eDate  = new Date(t.entryTs).toISOString();
        const xDate  = t.exitTs ? new Date(t.exitTs).toISOString() : '';
        const exitPx = t.tpLevels[0] ?? '';
        const conf   = `"${t.confluence.join(' ')}"`;
        return [
            idx + 1,
            eDate.slice(0, 10),
            eDate.slice(11, 16),
            t.symbol,
            t.side,
            t.entryPrice,
            t.slPrice,
            exitPx,
            xDate.slice(0, 10),
            xDate.slice(11, 16),
            t.finalR.toFixed(4),
            t.endReason,
            t.barsHeld,
            conf
        ].join(',');
    });

    fs.writeFileSync(filepath, [header, ...rows].join('\n'), 'utf-8');
    console.log(`\n📊 [CSV] Trade log saved to ${filepath}`);
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

    const strategyOverride = cleanArgs.find(a => a.startsWith('--strategy='))?.split('=')[1];

    if (cleanArgs.includes('--preset=15')) {
        symbols = COINS_15;
    } else if (cleanArgs.includes('--preset=40')) {
        symbols = COINS_40;
    } else if (cleanArgs.includes('--preset=quality')) {
        symbols = COINS_QUALITY;
    } else if (cleanArgs.includes('--preset=scalp')) {
        symbols = COINS_SCALP;
    } else if (cleanArgs.includes('--preset=curated')) {
        symbols = COINS_CURATED;
    } else if (cleanArgs.includes('--preset=3year')) {
        symbols = COINS_15;
        days = 1095; // ~3 years (June 2023 – June 2026)
    } else if (cleanArgs.includes('--preset=screener')) {
        console.log('\n📡 Running live screener to get today\'s coin list...');
        symbols = await Screener.getTopTrendingCoins(20);
        if (symbols.length === 0) { console.error('❌ Screener returned 0 coins'); process.exit(1); }
    } else if (cleanArgs.filter(a => !a.startsWith('--')).length > 0) {
        // Argumen non-flag dianggap sebagai simbol koin
        symbols = cleanArgs.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());
        if (symbols.length === 0) symbols = COINS_15;
    } else {
        // Default: run all 15 coins
        symbols = COINS_15;
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
        const trades = strategyOverride === 'ema_impulse'
            ? await runEmaImpulseBacktest(symbols[idx], days, !isBatch)
            : strategyOverride === 'ema_impulse_trail'
            ? await runEmaImpulseBacktest(symbols[idx], days, !isBatch, true)
            : strategyOverride === 'retest_reject'
            ? await runRetestRejectBacktest(symbols[idx], days, !isBatch)
            : strategyOverride === 'donchian'
            ? await runDonchianBacktest(symbols[idx], days, !isBatch)
            : strategyOverride === 'donchian_aggro'
            ? await runDonchianBacktest(symbols[idx], days, !isBatch, DON_AGGRO_CHANNEL, DON_AGGRO_TRAIL, false)
            : strategyOverride === 'mtf_vwap'
            ? await runMtfVwapBacktest(symbols[idx], days, !isBatch)
            : strategyOverride === 'scalp_bb'
            ? await runScalpBBBacktest(symbols[idx], days, !isBatch)
            : await runBacktest(symbols[idx], days, !isBatch);
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

        // Save combined trade CSV
        if (allTrades.length > 0) {
            const ts2 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            saveTradesToCsv(allTrades.sort((a, b) => a.entryTs - b.entryTs), `trades_${symbols.length}coins_${days}d_${ts2}.csv`);
        }
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

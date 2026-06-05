import WebSocket from 'ws';
import { ScoringEngine } from './scoring';
import { ExecutionEngine } from './execution';
import { findSwings, detectBias, findFVGs, isFVGUnmitigated, hasDisplacement, priceInZone } from './smc';

export let marketData: Record<string, any> = {};

let ws: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let currentCoins: string[] = [];

const WS_URL = 'wss://ws.bitget.com/v2/ws/public';
const PING_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 8;

// --- Caching Engine untuk Dashboard ---
type PlanStatus = 'READY' | 'WAITING' | 'INVALIDATED';
const PLAN_STALENESS_PCT = 0.02;
const PLAN_MIN_RR = 3; // Menyesuaikan SMC_CONFIG.minRR lu yaitu 3
const PLAN_DISP_BODY = 0.5;

function pickActionableFVG(fvgs: any[], currentPrice: number, side: 'LONG' | 'SHORT') {
    const tolerance = PLAN_STALENESS_PCT;
    const actionable = fvgs.filter(f => {
        if (currentPrice >= f.bottom && currentPrice <= f.top) return true;
        if (side === 'LONG') {
            return currentPrice > f.top && currentPrice <= f.top * (1 + tolerance);
        } else {
            return currentPrice < f.bottom && currentPrice >= f.bottom * (1 - tolerance);
        }
    });
    if (actionable.length === 0) return null;
    return actionable.sort((a, b) =>
        Math.abs((a.top + a.bottom) / 2 - currentPrice) -
        Math.abs((b.top + b.bottom) / 2 - currentPrice)
    )[0];
}

function computePlan(data: any, currentPrice: number): { side: 'LONG' | 'SHORT'; entry: number; sl: number; tp: number; status: PlanStatus } | null {
    const highs1h: number[] = data?.highs1h ?? [];
    const lows1h: number[] = data?.lows1h ?? [];
    const closes1h: number[] = data?.closes1h ?? [];
    const opens5m: number[] = data?.opens5m ?? [];
    const highs5m: number[] = data?.highs5m ?? [];
    const lows5m: number[] = data?.lows5m ?? [];
    const closes5m: number[] = data?.closes5m ?? [];
    if (highs1h.length < 5 || highs5m.length < 10) return null;

    const htfSwings = findSwings(highs1h, lows1h, 2);
    const bias = detectBias(htfSwings);
    if (bias === 'NEUTRAL') return null;

    const fvgSide: 'BULLISH' | 'BEARISH' = bias === 'BULLISH' ? 'BULLISH' : 'BEARISH';
    const side: 'LONG' | 'SHORT' = bias === 'BULLISH' ? 'LONG' : 'SHORT';

    const htfFvgs = findFVGs(highs1h, lows1h, fvgSide, 15).filter(f => isFVGUnmitigated(f, closes1h));
    const htfFvg = htfFvgs.find(f => priceInZone(currentPrice, f));
    if (!htfFvg) return null;

    const allFvgs = findFVGs(highs5m, lows5m, fvgSide, 30).filter(f => isFVGUnmitigated(f, closes5m));
    const fvg = pickActionableFVG(allFvgs, currentPrice, side);
    if (!fvg) return null;

    let tps: number[];
    if (side === 'LONG') {
        tps = htfSwings.filter(s => s.type === 'HIGH' && s.price > currentPrice).map(s => s.price).sort((a, b) => a - b);
    } else {
        tps = htfSwings.filter(s => s.type === 'LOW' && s.price < currentPrice).map(s => s.price).sort((a, b) => b - a);
    }
    if (tps.length === 0) return null;

    const sl = side === 'LONG' ? fvg.bottom * 0.998 : fvg.top * 1.002;
    const farTP = tps[Math.min(tps.length - 1, 1)];
    const rr = side === 'LONG' ? (farTP - currentPrice) / (currentPrice - sl) : (currentPrice - farTP) / (sl - currentPrice);
    if (!isFinite(rr) || rr < PLAN_MIN_RR) return null;

    const midIdx = fvg.index - 1;
    const fvgIdx = fvg.index;
    const dispMid = midIdx >= 0 && hasDisplacement(opens5m[midIdx], closes5m[midIdx], highs5m[midIdx], lows5m[midIdx], fvgSide, PLAN_DISP_BODY);
    const dispFvg = hasDisplacement(opens5m[fvgIdx], closes5m[fvgIdx], highs5m[fvgIdx], lows5m[fvgIdx], fvgSide, PLAN_DISP_BODY);
    const dispOK = dispMid || dispFvg;

    const inZone = currentPrice >= fvg.bottom && currentPrice <= fvg.top;
    let status: PlanStatus;
    if (inZone && dispOK) {
        status = 'READY';
    } else if (side === 'LONG') {
        if (currentPrice > fvg.top || (inZone && !dispOK)) status = 'WAITING';
        else status = 'INVALIDATED';
    } else {
        if (currentPrice < fvg.bottom || (inZone && !dispOK)) status = 'WAITING';
        else status = 'INVALIDATED';
    }

    return { side, entry: side === 'LONG' ? fvg.top : fvg.bottom, sl, tp: tps[0], status };
}
// -------------------------------------

function buildSubscribeArgs(coins: string[]) {
    return coins.flatMap(c => [
        { instType: 'USDT-FUTURES', channel: 'candle5m',  instId: c },
        { instType: 'USDT-FUTURES', channel: 'candle15m', instId: c },
        { instType: 'USDT-FUTURES', channel: 'candle1H',  instId: c },
        { instType: 'USDT-FUTURES', channel: 'candle4H',  instId: c }
    ]);
}

function clearTimers() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    if (reconnectAttempts >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`🛑 [WS] Halted after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`);
        return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, reconnectAttempts));
    reconnectAttempts++;
    console.log(`🔄 [WS] Reconnect in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/${MAX_CONSECUTIVE_FAILURES})`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

function connect() {
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        console.log(`✅ [WS] Connected (attempts cleared from ${reconnectAttempts})`);
        reconnectAttempts = 0;
        ws!.send(JSON.stringify({ op: 'subscribe', args: buildSubscribeArgs(currentCoins) }));

        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
        }, PING_MS);
    });

    ws.on('message', async (raw: WebSocket.RawData) => {
        const text = raw.toString();
        if (text === 'pong') return;

        let parsed: any;
        try { parsed = JSON.parse(text); } catch { return; }

        if (parsed.action !== 'update') {
            if (parsed.event === 'error' || parsed.code !== '0' && parsed.code !== undefined) {
                console.error(`❌ [WS] Server error:`, JSON.stringify(parsed));
            }
            return;
        }
        if (!parsed.data) return;

        const channel = parsed.arg.channel;
        const is1H  = channel === 'candle1H';
        const is4H  = channel === 'candle4H';
        const is15m = channel === 'candle15m';
        const symbol = parsed.arg.instId;
        const candle = parsed.data[0];

        const ts: string = candle[0];
        const open = parseFloat(candle[1]);
        const high = parseFloat(candle[2]);
        const low = parseFloat(candle[3]);
        const close = parseFloat(candle[4]);
        const volume = parseFloat(candle[5] ?? '0');

        const m = marketData[symbol];
        if (!m) return;
        const dataKey = is1H ? '1h' : is4H ? '4h' : is15m ? '15m' : '5m';

        const lastTsStr: string = m[`lastTs${dataKey}`] || '';
        if (lastTsStr !== '') {
            const tsNum = parseInt(ts, 10);
            const lastTsNum = parseInt(lastTsStr, 10);
            if (tsNum < lastTsNum) return;
        }

        if (m[`lastTs${dataKey}`] !== ts) {
            if (m[`lastTs${dataKey}`] !== '') {
                if (dataKey === '5m') {
                    const signal = ScoringEngine.evaluateSMCMTF(symbol, m, '5m');
                    if (signal) await ExecutionEngine.openPositionSMC(signal);
                } else if (dataKey === '15m') {
                    const signal = ScoringEngine.evaluateSMCMTF(symbol, m, '15m');
                    if (signal) await ExecutionEngine.openPositionSMC(signal);
                }
            }
            m[`opens${dataKey}`].push(open);
            m[`highs${dataKey}`].push(high);
            m[`lows${dataKey}`].push(low);
            m[`closes${dataKey}`].push(close);
            m[`volumes${dataKey}`].push(volume);
            m[`lastTs${dataKey}`] = ts;
            if (m[`closes${dataKey}`].length > 100) {
                m[`opens${dataKey}`].shift();
                m[`highs${dataKey}`].shift();
                m[`lows${dataKey}`].shift();
                m[`closes${dataKey}`].shift();
                m[`volumes${dataKey}`].shift();
            }
        } else {
            const idx = m[`closes${dataKey}`].length - 1;
            m[`highs${dataKey}`][idx] = Math.max(m[`highs${dataKey}`][idx], high);
            m[`lows${dataKey}`][idx] = Math.min(m[`lows${dataKey}`][idx], low);
            m[`closes${dataKey}`][idx] = close;
            m[`volumes${dataKey}`][idx] = volume;
        }

        // Jalankan caching rencana trading tepat setelah data koin diperbarui
        if (m.closes5m && m.closes5m.length > 0) {
            m.currentPlan = computePlan(m, m.closes5m[m.closes5m.length - 1]);
        }
    });

    ws.on('error', (err: Error) => {
        console.error('❌ [WS] Error:', err.message);
    });

    ws.on('close', (code: number, reason: Buffer) => {
        console.warn(`⚠️  [WS] Closed (code=${code}) ${reason.toString() || ''}`);
        clearTimers();
        scheduleReconnect();
    });
}

export function startWebsocket(dynamicCoins: string[], prefilledData: any) {
    marketData = prefilledData;
    // Pre-calculate rencana trading awal untuk semua koin ter-injeksi
    for (const sym of dynamicCoins) {
        const m = marketData[sym];
        if (m && m.closes5m && m.closes5m.length > 0) {
            m.currentPlan = computePlan(m, m.closes5m[m.closes5m.length - 1]);
        }
    }
    currentCoins = dynamicCoins;
    connect();
}

export function updateWatchlist(newCoins: string[], newData: Record<string, any>) {
    const toRemove = currentCoins.filter(c => !newCoins.includes(c));
    const toAdd = newCoins.filter(c => !currentCoins.includes(c));
    if (toRemove.length === 0 && toAdd.length === 0) return;

    for (const sym of toAdd) {
        if (newData[sym]) {
            marketData[sym] = newData[sym];
            if (marketData[sym].closes5m && marketData[sym].closes5m.length > 0) {
                marketData[sym].currentPlan = computePlan(marketData[sym], marketData[sym].closes5m[marketData[sym].closes5m.length - 1]);
            }
        }
    }
    for (const sym of toRemove) {
        delete marketData[sym];
    }
    currentCoins = newCoins;

    if (ws?.readyState === WebSocket.OPEN) {
        if (toRemove.length > 0) {
            ws.send(JSON.stringify({ op: 'unsubscribe', args: buildSubscribeArgs(toRemove) }));
        }
        if (toAdd.length > 0) {
            ws.send(JSON.stringify({ op: 'subscribe', args: buildSubscribeArgs(toAdd) }));
        }
    }
    console.log(`🔄 [SCREENER] Watchlist updated: +[${toAdd.join(', ') || 'none'}] -[${toRemove.join(', ') || 'none'}]`);
}
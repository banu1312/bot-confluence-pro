import WebSocket from 'ws';
import { ExecutionEngine } from './execution';
import { findSwings, detectBias, findFVGs, isFVGUnmitigated, hasDisplacement, priceInZone } from './smc';
import { getStrategyInstance } from './strategies/StrategyFactory';
import { SmcStrategy } from './strategies/SmcStrategy';
import { RsiFiboStrategy } from './strategies/RsiFiboStrategy';

export let marketData: Record<string, any> = {};

let ws: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
let currentCoins: string[] = [];

// Health check state
let lastPongTime: number = Date.now();
let healthCheckInterval: NodeJS.Timeout | null = null;
export const wsHealth = {
    connected: false,
    lastPongAge: 0,        // seconds since last pong
    lastMessageAge: 0,     // seconds since last data message
    lastMessageTime: 0,    // timestamp of last data message
    reconnectAttempts: 0,
    status: 'DISCONNECTED' as 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING' | 'ERROR'
};

const WS_URL = process.env.WS_URL || 'wss://ws.bitget.com/v2/ws/public';
const PING_MS = parseInt(process.env.WS_PING_MS || '25000', 10);
const MAX_BACKOFF_MS = parseInt(process.env.WS_MAX_BACKOFF_MS || '30000', 10);
const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.WS_MAX_CONSECUTIVE_FAILURES || '8', 10);
const HEALTH_CHECK_MS = parseInt(process.env.WS_HEALTH_CHECK_MS || '30000', 10);  // check every 30 seconds
const PONG_TIMEOUT_MS = parseInt(process.env.WS_PONG_TIMEOUT_MS || '60000', 10);  // consider dead after 60s without pong

// --- Caching Engine untuk Dashboard ---
type PlanStatus = 'READY' | 'WAITING' | 'INVALIDATED';

// ─── Fungsi untuk mendeteksi BOS di LTF ────────────────────────────────────
function detectBOS(
    highs: number[],
    lows: number[],
    side: 'LONG' | 'SHORT',
    lookback: number = 5
): boolean {
    if (highs.length < lookback + 2) return false;

    const recentHighs = highs.slice(-lookback);
    const recentLows = lows.slice(-lookback);

    if (side === 'LONG') {
        // BOS bullish: harga menembus swing high terakhir
        const prevHigh = Math.max(...recentHighs.slice(0, -1));
        const currentHigh = recentHighs[recentHighs.length - 1];
        return currentHigh > prevHigh;
    } else {
        // BOS bearish: harga menembus swing low terakhir
        const prevLow = Math.min(...recentLows.slice(0, -1));
        const currentLow = recentLows[recentLows.length - 1];
        return currentLow < prevLow;
    }
}

// ─── Fungsi untuk menggeser SL ke Breakeven ────────────────────────────────
function moveSLToBreakeven(symbol: string, entryPrice: number) {
    const pos = StateManager.find(symbol);
    if (!pos) return;

    // Hanya geser jika belum pernah di-breakeven
    if (pos.breakevenMoved) return;

    // Geser SL ke entry price
    pos.slPrice = entryPrice;
    pos.breakevenMoved = true;

    // Update di state manager
    StateManager.updateAfterTp1(symbol, entryPrice, null, pos.qty);
    console.log(`🔒 [BE] ${symbol}: SL moved to breakeven (${entryPrice})`);
}

// ─── Fungsi monitoring posisi aktif ────────────────────────────────────────
function monitorActivePositions() {
    for (const pos of StateManager.positions) {
        const data = marketData[pos.symbol];
        if (!data) continue;

        const ltfHighs = data.highs5m;
        const ltfLows = data.lows5m;
        const ltfCloses = data.closes5m;

        if (ltfHighs.length < 10) continue;

        // Deteksi BOS di LTF
        const bosDetected = detectBOS(ltfHighs, ltfLows, pos.side, 5);

        if (bosDetected && !pos.breakevenMoved) {
            moveSLToBreakeven(pos.symbol, pos.entryPrice);
        }
    }
}
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
    if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null; }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    if (reconnectAttempts >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`🛑 [WS] Halted after ${MAX_CONSECUTIVE_FAILURES} consecutive failures.`);
        wsHealth.status = 'ERROR';
        return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, reconnectAttempts));
    reconnectAttempts++;
    wsHealth.reconnectAttempts = reconnectAttempts;
    wsHealth.status = 'RECONNECTING';
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
        wsHealth.reconnectAttempts = 0;
        wsHealth.connected = true;
        wsHealth.status = 'CONNECTED';
        ws!.send(JSON.stringify({ op: 'subscribe', args: buildSubscribeArgs(currentCoins) }));

        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) ws.send('ping');
        }, PING_MS);

        // Monitoring posisi aktif setiap 5 detik
        setInterval(monitorActivePositions, 5000);

        // Start health check interval
        if (healthCheckInterval) clearInterval(healthCheckInterval);
        healthCheckInterval = setInterval(() => {
            const now = Date.now();
            const pongAge = (now - lastPongTime) / 1000;
            const msgAge = wsHealth.lastMessageTime > 0 ? (now - wsHealth.lastMessageTime) / 1000 : 0;
            wsHealth.lastPongAge = pongAge;
            wsHealth.lastMessageAge = msgAge;

            if (pongAge > PONG_TIMEOUT_MS / 1000) {
                console.warn(`⚠️  [WS HEALTH] No pong for ${pongAge.toFixed(0)}s — forcing reconnect`);
                wsHealth.status = 'ERROR';
                ws?.close();
                return;
            }

            if (msgAge > 120) { // 2 minutes without data
                console.warn(`⚠️  [WS HEALTH] No data for ${msgAge.toFixed(0)}s — possible stale connection`);
                wsHealth.status = 'ERROR';
                ws?.close();
                return;
            }

            wsHealth.status = 'CONNECTED';
        }, HEALTH_CHECK_MS);
    });

    ws.on('message', async (raw: WebSocket.RawData) => {
        const text = raw.toString();
        if (text === 'pong') {
            lastPongTime = Date.now();
            return;
        }
        wsHealth.lastMessageTime = Date.now();

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
                const strategy = getStrategyInstance(symbol);
                
                if (strategy.name === 'smc') {
                    const smcStrategy = strategy as SmcStrategy;
                    if (dataKey === '5m') {
                        const signal = smcStrategy.evaluateSMCMTF(symbol, m, '5m');
                        if (signal) await ExecutionEngine.openPositionSMC(signal);
                    } else if (dataKey === '15m') {
                        const signal = smcStrategy.evaluateSMCMTF(symbol, m, '15m');
                        if (signal) await ExecutionEngine.openPositionSMC(signal);
                    }
                } else if (strategy.name === 'rsi_fibo') {
                    const rsiFiboStrategy = strategy as RsiFiboStrategy;
                    if (dataKey === '4h') {
                        const candle4h = {
                            open: m.opens4h[m.opens4h.length - 1],
                            high: m.highs4h[m.highs4h.length - 1],
                            low: m.lows4h[m.lows4h.length - 1],
                            close: m.closes4h[m.closes4h.length - 1],
                            ts: parseInt(m.lastTs4h, 10)
                        };
                        const triggerContext = await rsiFiboStrategy.checkHTFTrigger(symbol, candle4h);
                        if (triggerContext) {
                            m._rsiFiboTrigger = triggerContext;
                        }
                    } else if (dataKey === '15m' && m._rsiFiboTrigger) {
                        const candle15m = {
                            open: m.opens15m[m.opens15m.length - 1],
                            high: m.highs15m[m.highs15m.length - 1],
                            low: m.lows15m[m.lows15m.length - 1],
                            close: m.closes15m[m.closes15m.length - 1],
                            ts: parseInt(m.lastTs15m, 10)
                        };
                        const entryResult = await rsiFiboStrategy.checkLTFEntry(symbol, m._rsiFiboTrigger, candle15m);
                        if (entryResult && entryResult.action === 'filled') {
                            const signal = {
                                symbol,
                                side: entryResult.context.side,
                                entryPrice: entryResult.context.entryPrice,
                                slPrice: entryResult.context.slPrice,
                                tpLevels: [],
                                tpPrice: 0,
                                confluence: ['RSI-FIBO'],
                                ltfTimeframe: '15m' as const,
                                data: m
                            };
                            await ExecutionEngine.openPositionSMC(signal);
                        }
                    }
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
        wsHealth.connected = false;
        wsHealth.status = 'DISCONNECTED';
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

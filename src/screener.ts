import axios from 'axios';

// Sanity guard: ensure candle rows are in ascending timestamp order (oldest → newest).
// Bitget V2 currently returns ascending; this protects against silent breakage if the
// API order ever changes again. Returns the (possibly reversed) array.
function ensureAscending(rows: any[], label: string): any[] {
    if (!Array.isArray(rows) || rows.length < 2) return rows;
    const firstTs = parseInt(rows[0][0], 10);
    const lastTs = parseInt(rows[rows.length - 1][0], 10);
    if (firstTs > lastTs) {
        console.warn(`⚠️  [CHRONO] ${label}: API returned DESCENDING order — auto-reversing. Check Bitget API docs if this persists.`);
        return [...rows].reverse();
    }
    if (firstTs === lastTs) {
        console.warn(`⚠️  [CHRONO] ${label}: first/last timestamps identical — suspicious data.`);
    }
    return rows;
}

// Fixed liquid universe for ema_impulse_trail (4H EMA50 impulse + chandelier trail).
// = COINS_QUALITY from backtest.ts minus APT/TRX (the only 2/22 losers in the
// 5yr/1825d validation: APT -7.19R, TRX -20.78R; 20/22 profitable, +398.3R total).
// Fixed and reviewed periodically — NOT re-sorted by daily |change24h| (that broke
// multi-day trend tracking and couldn't be backtested identically).
const TRADING_UNIVERSE: string[] = [
    'BTCUSDT',  'ETHUSDT',  'SOLUSDT',  'XRPUSDT',  'UNIUSDT',
    'LTCUSDT',  'NEARUSDT', 'ARBUSDT',  'OPUSDT',   'FETUSDT',
    'TONUSDT',  'JUPUSDT',  'ENAUSDT',  'GMXUSDT',  'SANDUSDT',
    'IMXUSDT',  'FILUSDT',  'LDOUSDT',  'GALAUSDT', 'RUNEUSDT'
];

export class Screener {
    // 1. Watchlist tetap — basket terkurasi dari backtest, bukan hasil screening harian.
    public static async getTopTrendingCoins(limit: number = 20): Promise<string[]> {
        const coins = TRADING_UNIVERSE.slice(0, limit);
        console.log(`✅ [SCREENER] Fixed universe: ${coins.length} coins: ${coins.join(', ')}`);
        return coins;
    }

    // 2. Fungsi Download Sejarah Harga (OHLC untuk SMC MTF: 5m, 1H & 4H)
    public static async injectMemory(symbol: string) {
        try {
            // DOWNLOAD DATA 5 MENIT, 15 MENIT, 1 JAM, DAN 4 JAM
            const [res5m, res15m, res1h, res4h] = await Promise.all([
                axios.get(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=5m&limit=100&productType=USDT-FUTURES`),
                axios.get(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=15m&limit=100&productType=USDT-FUTURES`),
                axios.get(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=1H&limit=100&productType=USDT-FUTURES`),
                axios.get(`https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&granularity=4H&limit=100&productType=USDT-FUTURES`)
            ]);

            if (!res5m.data.data || !res15m.data.data || !res1h.data.data || !res4h.data.data) {
                throw new Error("Data candle kosong dari Bitget");
            }

            // Bitget V2 candles endpoint returns OLDEST → NEWEST (ascending by timestamp).
            // Sanity check: if exchange ever flips order again, auto-correct + warn loudly.
            const candles5m = ensureAscending(res5m.data.data, `${symbol} 5m`);
            const candles15m = ensureAscending(res15m.data.data, `${symbol} 15m`);
            const candles1h = ensureAscending(res1h.data.data, `${symbol} 1h`);
            const candles4h = ensureAscending(res4h.data.data, `${symbol} 4h`);

            // FORMAT BITGET OHLC: [0]Ts, [1]Open, [2]High, [3]Low, [4]Close, [5]Volume

            // Ekstrak anatomi 5 Menit (LTF)
            const opens5m = candles5m.map((c: any) => parseFloat(c[1]));
            const highs5m = candles5m.map((c: any) => parseFloat(c[2]));
            const lows5m = candles5m.map((c: any) => parseFloat(c[3]));
            const closes5m = candles5m.map((c: any) => parseFloat(c[4]));
            const volumes5m = candles5m.map((c: any) => parseFloat(c[5]));
            const lastTs5m = candles5m[candles5m.length - 1][0];

            // Ekstrak anatomi 15 Menit (Mid-LTF)
            const opens15m = candles15m.map((c: any) => parseFloat(c[1]));
            const highs15m = candles15m.map((c: any) => parseFloat(c[2]));
            const lows15m = candles15m.map((c: any) => parseFloat(c[3]));
            const closes15m = candles15m.map((c: any) => parseFloat(c[4]));
            const volumes15m = candles15m.map((c: any) => parseFloat(c[5]));
            const lastTs15m = candles15m[candles15m.length - 1][0];

            // Ekstrak anatomi 1 Jam (HTF)
            const opens1h = candles1h.map((c: any) => parseFloat(c[1]));
            const highs1h = candles1h.map((c: any) => parseFloat(c[2]));
            const lows1h = candles1h.map((c: any) => parseFloat(c[3]));
            const closes1h = candles1h.map((c: any) => parseFloat(c[4]));
            const volumes1h = candles1h.map((c: any) => parseFloat(c[5]));
            const lastTs1h = candles1h[candles1h.length - 1][0];

            // Ekstrak anatomi 4 Jam (Major HTF)
            const opens4h = candles4h.map((c: any) => parseFloat(c[1]));
            const highs4h = candles4h.map((c: any) => parseFloat(c[2]));
            const lows4h = candles4h.map((c: any) => parseFloat(c[3]));
            const closes4h = candles4h.map((c: any) => parseFloat(c[4]));
            const volumes4h = candles4h.map((c: any) => parseFloat(c[5]));
            const lastTs4h = candles4h[candles4h.length - 1][0];

            // Kembalikan objek utuh sesuai permintaan otak SMC di websocket.ts
            return {
                opens5m, highs5m, lows5m, closes5m, volumes5m, lastTs5m,
                opens15m, highs15m, lows15m, closes15m, volumes15m, lastTs15m,
                opens1h, highs1h, lows1h, closes1h, volumes1h, lastTs1h,
                opens4h, highs4h, lows4h, closes4h, volumes4h, lastTs4h
            };

        } catch (error: any) {
            console.error(`❌ Gagal suntik memori SMC untuk ${symbol}:`, error.message);
            // Return array kosong agar bot tidak crash, tapi membiarkan websocket mengisi secara live
            return {
                opens5m: [], highs5m: [], lows5m: [], closes5m: [], volumes5m: [], lastTs5m: '',
                opens15m: [], highs15m: [], lows15m: [], closes15m: [], volumes15m: [], lastTs15m: '',
                opens1h: [], highs1h: [], lows1h: [], closes1h: [], volumes1h: [], lastTs1h: '',
                opens4h: [], highs4h: [], lows4h: [], closes4h: [], volumes4h: [], lastTs4h: ''
            };
        }
    }
}
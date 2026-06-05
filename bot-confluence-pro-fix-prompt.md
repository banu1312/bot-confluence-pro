# Brief: Fix bot-confluence-pro SMC Strategy

## Context

Project ini trading bot crypto di Bitget (TypeScript + Node.js, no build, jalan via `ts-node`) yang pakai SMC multi-timeframe strategy. Bias dari 1H structure, entry & SL dari 5m FVG, TP dari structural swing 1H.

Audit code menemukan beberapa bug yang bikin entry sering ngelawan arah trend besar, plus filter quality di-disable yang harusnya tetep aktif.

**Lo tugasnya fix ini step-by-step, JANGAN bundle semua perubahan jadi satu.**

## File Structure

```
src/
├── smc.ts          # SMC primitives (swings, FVG, bias, sweep, OB, displacement)
├── scoring.ts      # ScoringEngine - kombinasi gates → entry decision
├── execution.ts    # ExecutionEngine - kirim order ke Bitget API
├── websocket.ts    # Bitget WS feed + trigger evaluation on candle close
├── screener.ts     # Pick top coins to watch
├── state.ts        # Position state
├── server.ts       # Dashboard (jangan disentuh)
├── index.ts        # Entry point
└── backtest.ts     # Backtest runner — pakai `npm run backtest`
```

## Working Protocol — PENTING

Untuk SETIAP priority di bawah:

1. Baca kode current state file yang relevan
2. Apply perubahan
3. Jalanin `npx tsc --noEmit` untuk validate TypeScript ga error
4. Jalanin `npm run backtest` (kalau ada symbol di env, kalau ga skip step ini)
5. Stop & summarize: "Priority N selesai, hasil backtest: [metrics]. Lanjut ke Priority N+1?"
6. **TUNGGU konfirmasi user sebelum lanjut.**

Tujuan: bisa isolasi impact tiap perubahan, kalau ada regression bisa pinpoint dari mana.

---

## PRIORITY 1: Fix Bias Detection (CRITICAL)

**Bug**: `detectBias()` di `src/smc.ts` cuma compare 2 swing high terakhir & 2 swing low terakhir. Dengan `findSwings` lookback=2, ini detect micro-fractals. Pullback wajar di uptrend bisa flip bias ke BEARISH → bot SHORT pas harusnya LONG.

**Fix**: Replace `detectBias` dengan BOS-based detection.

Edit `src/smc.ts`, replace fungsi `detectBias`:

```typescript
// ─── 2. Market structure bias from BOS (Break of Structure) ─────────────────
// BULLISH bias: latest move broke prior swing HIGH (made new HH after a HL).
// BEARISH bias: latest move broke prior swing LOW (made new LL after a LH).
// Uses last 6 swings (≈3 highs + 3 lows alternating) for robustness vs noise.
export function detectBias(swings: SwingPoint[]): Bias {
    // Ensure chronological order
    const sorted = [...swings].sort((a, b) => a.index - b.index);
    const recent = sorted.slice(-6);

    const highs = recent.filter(s => s.type === 'HIGH');
    const lows = recent.filter(s => s.type === 'LOW');
    if (highs.length < 2 || lows.length < 2) return 'NEUTRAL';

    const lastHigh = highs[highs.length - 1];
    const prevHigh = highs[highs.length - 2];
    const lastLow = lows[lows.length - 1];
    const prevLow = lows[lows.length - 2];

    // BULLISH BOS: most recent swing is a HIGH that broke previous high,
    // AND the intervening low was higher than the prior low (proper HH-HL).
    const bullishBOS =
        lastHigh.index > lastLow.index &&
        lastHigh.price > prevHigh.price &&
        lastLow.price > prevLow.price;

    // BEARISH BOS: most recent swing is a LOW that broke previous low,
    // AND the intervening high was lower than the prior high (proper LH-LL).
    const bearishBOS =
        lastLow.index > lastHigh.index &&
        lastLow.price < prevLow.price &&
        lastHigh.price < prevHigh.price;

    if (bullishBOS) return 'BULLISH';
    if (bearishBOS) return 'BEARISH';
    return 'NEUTRAL';
}
```

**Verification**: Run backtest, expect FEWER total trades but directional accuracy lebih bagus. Report total trades sebelum vs sesudah.

---

## PRIORITY 2: Add 4H HTF Bias Confirmation

**Bug**: 1H sebagai "HTF" terlalu kecil di SMC context. Real HTF adalah 4H/Daily.

**Fix**: Subscribe candle4H dan tambahin bias gate sebelum bias 1H.

### 2a. Update `MarketData` interface di `src/smc.ts`

```typescript
export interface MarketData {
    opens5m: number[]; highs5m: number[]; lows5m: number[]; closes5m: number[]; lastTs5m: string;
    opens1h: number[]; highs1h: number[]; lows1h: number[]; closes1h: number[]; lastTs1h: string;
    opens4h: number[]; highs4h: number[]; lows4h: number[]; closes4h: number[]; lastTs4h: string;
}
```

### 2b. Update `src/screener.ts` `injectMemory()` untuk fetch 4H

Tambahin parallel fetch untuk 4H candles (granularity=`4H`, limit=100). Extract opens4h, highs4h, lows4h, closes4h, lastTs4h. Return as part of object. Update error fallback juga.

### 2c. Update `src/websocket.ts`

- Update `buildSubscribeArgs` untuk subscribe `candle4H` juga
- Update message handler: kalau `parsed.arg.channel === 'candle4H'`, treat `dataKey = '4h'` (similar to 1H, ga trigger evaluation — 4H itu bias only)
- Pastikan tetap trigger `ScoringEngine.evaluateSMCMTF` cuma waktu 5m close baru

### 2d. Update `src/scoring.ts`

Tambah config:
```typescript
require4hBias: true,
htf4hSwingLookback: 2,
```

Di `evaluateSMCMTF`, tambah gate sebelum bias 1H:

```typescript
// Gate 1a: 4H HTF bias filter — major timeframe must align
const htf4hSwings = findSwings(data.highs4h, data.lows4h, SMC_CONFIG.htf4hSwingLookback);
const bias4h = detectBias(htf4hSwings);

// Gate 1b: 1H bias
const htfSwings = findSwings(data.highs1h, data.lows1h, SMC_CONFIG.htfSwingLookback);
const bias1h = detectBias(htfSwings);

// Combined: kalau require4hBias, 4H ga boleh contradict 1H
if (SMC_CONFIG.require4hBias) {
    if (bias4h === 'NEUTRAL') return null;
    if (bias1h !== 'NEUTRAL' && bias1h !== bias4h) return null;
}

// Final bias = 4H (master), fall back ke 1H kalau 4H neutral & require4hBias=false
const bias: Bias = bias4h !== 'NEUTRAL' ? bias4h : bias1h;

if (SMC_CONFIG.requireStructureBias && bias === 'NEUTRAL') return null;
```

Hapus baris `const bias = detectBias(htfSwings);` yang lama, karena udah di-handle di blok atas.

### 2e. Update `src/backtest.ts`

Tambahin fetch & build window untuk 4H candles. Similar to existing 1H logic. Update `buildMarketDataAt` untuk include 4h fields.

---

## PRIORITY 3: Re-enable Liquidity Sweep + Improve Detection

**Bug**: `requireLiquiditySweep: false` mematikan filter SMC paling reliable.

### 3a. Edit `src/scoring.ts` config:

```typescript
requireLiquiditySweep: true,   // RE-ENABLED — quality > quantity
sweepLookbackBars: 25,         // how far back to scan for liquidity targets
```

### 3b. Improve `detectLiquiditySweep` di `src/smc.ts`

Current implementation cuma cek 1 swing terakhir. Improve untuk scan multiple potential liquidity targets:

```typescript
// ─── 6. Liquidity sweep: stop-hunt then reclaim ─────────────────────────────
// For LONG: a recent candle wicked below ANY prior swing low (within lookback)
// AND closed back above it. Same logic mirrored for SHORT against swing highs.
export function detectLiquiditySweep(
    swings: SwingPoint[],
    highs: number[], lows: number[], closes: number[],
    side: 'LONG' | 'SHORT',
    recentBars: number = 5,
    sweepLookbackBars: number = 25
): boolean {
    const currentIdx = highs.length - 1;
    const cutoff = currentIdx - recentBars;
    const oldest = currentIdx - sweepLookbackBars;

    if (side === 'LONG') {
        const oldLows = swings.filter(s =>
            s.type === 'LOW' && s.index < cutoff && s.index >= oldest
        );
        if (oldLows.length === 0) return false;
        for (const oldLow of oldLows) {
            for (let i = Math.max(0, cutoff + 1); i <= currentIdx; i++) {
                if (lows[i] < oldLow.price && closes[i] > oldLow.price) return true;
            }
        }
    } else {
        const oldHighs = swings.filter(s =>
            s.type === 'HIGH' && s.index < cutoff && s.index >= oldest
        );
        if (oldHighs.length === 0) return false;
        for (const oldHigh of oldHighs) {
            for (let i = Math.max(0, cutoff + 1); i <= currentIdx; i++) {
                if (highs[i] > oldHigh.price && closes[i] < oldHigh.price) return true;
            }
        }
    }
    return false;
}
```

Update call site di `scoring.ts` untuk pass `sweepLookbackBars`:

```typescript
const swept = detectLiquiditySweep(
    ltfSwings,
    data.highs5m, data.lows5m, data.closes5m,
    side, SMC_CONFIG.sweepWindow, SMC_CONFIG.sweepLookbackBars
);
```

---

## PRIORITY 4: Re-enable Inducement Check

**Bug**: Posisi sering kena SL sebelum reach TP karena ada minor liquidity di tengah jalan yang di-grab smart money dulu.

### 4a. Edit `src/scoring.ts` config:

```typescript
requireNoInducement: true,
minInducementBars: 2,  // ignore very recent swings (might just be entry-area noise)
```

### 4b. Improve `hasInducement` di `src/smc.ts`:

```typescript
export function hasInducement(
    swings: SwingPoint[],
    side: 'LONG' | 'SHORT',
    entryPrice: number,
    tpPrice: number,
    currentIdx: number,
    minInducementBars: number = 2
): boolean {
    // Only consider swings that are mature (not just-formed near entry zone)
    const matureSwings = swings.filter(s => s.index < currentIdx - minInducementBars);
    
    if (side === 'LONG') {
        return matureSwings.some(s =>
            s.type === 'HIGH' && s.price > entryPrice && s.price < tpPrice
        );
    } else {
        return matureSwings.some(s =>
            s.type === 'LOW' && s.price < entryPrice && s.price > tpPrice
        );
    }
}
```

Update call site di `scoring.ts`:

```typescript
if (SMC_CONFIG.requireNoInducement) {
    if (hasInducement(ltfSwings, side, currentPrice, nearTP, data.closes5m.length - 1, SMC_CONFIG.minInducementBars)) return null;
    confluence.push('NO_INDUCEMENT');
}
```

---

## PRIORITY 5: Realistic RR + Use Nearest TP for Validation

**Bug**: RR=5 dengan SL 5m FVG bikin TP yang di-pick selalu jauh dari swing-swing lama yang ga relevan dengan move sekarang. Position jarang reach TP1, sering kena BE/SL.

### Edit `src/scoring.ts`:

Config change:
```typescript
minRR: 2,        // was 5 — realistic for SMC setups
tpCount: 2,
```

Change RR calculation untuk pake `nearTP` bukan `farTP`:

```typescript
// Gate 8: RR validation — pake NEAREST TP supaya geometry realistis
const rr = side === 'LONG'
    ? (nearTP - currentPrice) / (currentPrice - sl)
    : (currentPrice - nearTP) / (sl - currentPrice);
if (!isFinite(rr) || rr < SMC_CONFIG.minRR) return null;
confluence.push(`RR=${rr.toFixed(2)}`);
```

Rationale: TP1 yang realistis hit dalam 5-20 bars. TP2 bonus kalau momentum kuat. Setup yang lewat filter punya geometry yang masuk akal.

---

## PRIORITY 6: Smarter Screener

**Bug**: Sort by `change24h` desc pilih coin yang udah pump/dump 20%+ → structure rusak, swing noisy, SMC ga work.

### Edit `src/screener.ts` `getTopTrendingCoins`:

```typescript
public static async getTopTrendingCoins(limit: number = 15): Promise<string[]> {
    try {
        console.log("🔍 Mengecek market Bitget Futures (smart screener)...");
        const res = await axios.get('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES');
        let tickers = res.data.data;

        // FILTER 1: Likuiditas
        tickers = tickers.filter((t: any) =>
            t.symbol.endsWith('USDT') &&
            parseFloat(t.usdtVolume) > 10_000_000
        );

        // FILTER 2: Skip coins yang structure-nya rusak (extreme move) atau mati (no move)
        // 2%–15% range = ada momentum tapi belum extreme
        tickers = tickers.filter((t: any) => {
            const change = Math.abs(parseFloat(t.change24h || '0'));
            return change >= 0.02 && change <= 0.15;
        });

        // SCORE: volume-weighted moderate volatility
        tickers.sort((a: any, b: any) => {
            const volA = parseFloat(a.usdtVolume);
            const volB = parseFloat(b.usdtVolume);
            const chgA = Math.abs(parseFloat(a.change24h || '0'));
            const chgB = Math.abs(parseFloat(b.change24h || '0'));
            return (volB * chgB) - (volA * chgA);
        });

        const topCoins = tickers.slice(0, limit).map((t: any) => t.symbol);
        return topCoins;
    } catch (error: any) {
        console.error("❌ Gagal mengambil data screener:", error.message);
        return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
    }
}
```

---

## PRIORITY 7: Volume Confirmation di Displacement

**Bug**: Displacement check cuma body ratio, ignore volume. Candle gede tanpa volume itu bukan smart money — bisa jadi cuma low-liquidity wick.

### 7a. Update `MarketData` di `src/smc.ts`:

```typescript
export interface MarketData {
    opens5m: number[]; highs5m: number[]; lows5m: number[]; closes5m: number[]; volumes5m: number[]; lastTs5m: string;
    opens1h: number[]; highs1h: number[]; lows1h: number[]; closes1h: number[]; volumes1h: number[]; lastTs1h: string;
    opens4h: number[]; highs4h: number[]; lows4h: number[]; closes4h: number[]; volumes4h: number[]; lastTs4h: string;
}
```

### 7b. Update `src/screener.ts` `injectMemory()` untuk extract volume (index 5 di Bitget candle response).

### 7c. Update `src/websocket.ts` untuk track volume di setiap candle update (push + update in-place).

### 7d. Add ke `src/smc.ts`:

```typescript
// ─── 9b. Displacement with volume confirmation ─────────────────────────────
// Same as hasDisplacement but ALSO requires candle volume > avg * multiplier.
// Ensures the impulsive candle is backed by real participation.
export function hasDisplacementWithVolume(
    open: number, close: number, high: number, low: number,
    volume: number, avgVolume: number,
    side: 'BULLISH' | 'BEARISH',
    minBodyRatio: number = 0.5,
    minVolMultiplier: number = 1.2
): boolean {
    if (!hasDisplacement(open, close, high, low, side, minBodyRatio)) return false;
    if (avgVolume <= 0) return false;
    return volume >= avgVolume * minVolMultiplier;
}
```

### 7e. Update `scoring.ts` displacement gate:

```typescript
// Gate 5: Displacement + volume
if (SMC_CONFIG.requireDisplacement) {
    const fvgIdx = ltfFvg.index;
    const lookback = 20;
    const volWindow = data.volumes5m.slice(Math.max(0, fvgIdx - lookback), fvgIdx);
    const avgVol = volWindow.reduce((a, b) => a + b, 0) / Math.max(1, volWindow.length);

    const dispFvg = hasDisplacementWithVolume(
        data.opens5m[fvgIdx], data.closes5m[fvgIdx],
        data.highs5m[fvgIdx], data.lows5m[fvgIdx],
        data.volumes5m[fvgIdx], avgVol,
        fvgSide, SMC_CONFIG.displacementMinBody, SMC_CONFIG.displacementMinVolMultiplier
    );
    if (!dispFvg) return null;
    confluence.push('DISPLACEMENT_VOL');
}
```

Add config:
```typescript
displacementMinVolMultiplier: 1.2,
```

---

## PRIORITY 8: Minor Bug Fixes

### 8a. Fix `isFVGUnmitigated` loop bound di `src/smc.ts`

```typescript
export function isFVGUnmitigated(fvg: FVG, closes: number[]): boolean {
    for (let i = fvg.index + 1; i < closes.length; i++) {  // was: closes.length - 1
        if (fvg.side === 'BULLISH' && closes[i] < fvg.bottom) return false;
        if (fvg.side === 'BEARISH' && closes[i] > fvg.top) return false;
    }
    return true;
}
```

### 8b. Require FVG umur minimum sebelum jadi entry trigger

**Bug**: FVG yang baru terbentuk di candle terakhir bisa langsung trigger — chasing momentum, bukan SMC entry.

Add config di `scoring.ts`:
```typescript
minFvgAge: 2,  // FVG harus berumur minimal 2 bars sebelum jadi entry trigger
```

Update LTF FVG selection di `evaluateSide`:
```typescript
const currentIdx5m = data.closes5m.length - 1;
const ltfFvg = validLtfFvgs.find(f =>
    priceInZone(currentPrice, f) &&
    (currentIdx5m - f.index) >= SMC_CONFIG.minFvgAge
);
```

Sama untuk HTF FVG (1H):
```typescript
const currentIdx1h = data.closes1h.length - 1;
const htfFvg = validHtfFvgs.find(f =>
    priceInZone(currentPrice, f) &&
    (currentIdx1h - f.index) >= SMC_CONFIG.minFvgAge
);
```

### 8c. Optional: Re-enable OB confluence

Set `requireOBConfluence: true` di config. Ini optional — bisa di-skip kalau setelah priority 1-7 udah cukup selektif (kalau total trade per minggu < 5, jangan enable ini).

---

## PRIORITY 9: Final Verification

Setelah semua priority selesai:

1. Run `npx tsc --noEmit` — pastikan no TypeScript errors
2. Run `npm run backtest` di multiple symbols (BTC, ETH, SOL minimum)
3. Compare metrics:

| Metric | Sebelum | Sesudah | Target |
|--------|---------|---------|--------|
| Total trades | ? | ? | Significantly fewer (lebih selektif) |
| Win rate | ? | ? | ≥ 50% |
| Avg R per trade | ? | ? | ≥ +0.3R |
| Max drawdown | ? | ? | < 5R |
| Profit factor | ? | ? | > 1.5 |

4. Kalau total trades < 5 per minggu, terlalu ketat — set `requireOBConfluence: false`, atau turunin `minRR` ke 1.8
5. Kalau win rate < 40%, ada filter yang ga work — check log mana yang sering reject vs accept

---

## Important Notes

- **JANGAN sentuh** `.env` file (skip baca file ini)
- **JANGAN sentuh** `server.ts`, `state.ts`, `execution.ts` API logic (struktur signal-nya udah OK, masalah di scoring/SMC primitives)
- **JANGAN run** real-trading mode — semua test pakai backtest doang sampai user explicit izinin
- Setiap priority selesai, JANGAN otomatis lanjut. STOP dan tunggu konfirmasi.

Mulai dari Priority 1.

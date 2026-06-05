// Smart Money Concept detection primitives.
// All functions are pure: take series + params, return analysis.

export interface MarketData {
    opens5m: number[]; highs5m: number[]; lows5m: number[]; closes5m: number[]; volumes5m: number[]; lastTs5m: string;
    opens15m: number[]; highs15m: number[]; lows15m: number[]; closes15m: number[]; volumes15m: number[]; lastTs15m: string;
    opens1h: number[]; highs1h: number[]; lows1h: number[]; closes1h: number[]; volumes1h: number[]; lastTs1h: string;
    opens4h: number[]; highs4h: number[]; lows4h: number[]; closes4h: number[]; volumes4h: number[]; lastTs4h: string;
}

export interface SwingPoint {
    index: number;
    price: number;
    type: 'HIGH' | 'LOW';
}

export interface FVG {
    index: number;      // index of the candle whose low (bullish) or high (bearish) closes the gap
    top: number;
    bottom: number;
    side: 'BULLISH' | 'BEARISH';
}

export interface Zone {
    top: number;
    bottom: number;
}

export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

// ─── 1. Swing detection (fractal pivot) ─────────────────────────────────────
// A candle at index i is a swing high if its high is strictly greater than the
// `lookback` candles on both sides. Symmetric definition for swing lows.
export function findSwings(highs: number[], lows: number[], lookback: number = 2): SwingPoint[] {
    // Guard: insufficient data for swing detection
    if (highs.length < lookback * 2 + 1 || lows.length < lookback * 2 + 1) {
        return [];
    }
    const out: SwingPoint[] = [];
    for (let i = 0; i < highs.length; i++) {
        // Need at least lookback candles on both sides to be a valid swing
        if (i < lookback || i >= highs.length - lookback) {
            // Edge candles can still be swings if they are the highest/lowest in the window
            let isHigh = true, isLow = true;
            for (let k = 1; k <= lookback; k++) {
                if (i - k >= 0) {
                    if (highs[i] <= highs[i - k]) isHigh = false;
                    if (lows[i] >= lows[i - k]) isLow = false;
                }
                if (i + k < highs.length) {
                    if (highs[i] <= highs[i + k]) isHigh = false;
                    if (lows[i] >= lows[i + k]) isLow = false;
                }
            }
            if (isHigh) out.push({ index: i, price: highs[i], type: 'HIGH' });
            if (isLow) out.push({ index: i, price: lows[i], type: 'LOW' });
        } else {
            let isHigh = true, isLow = true;
            for (let k = 1; k <= lookback; k++) {
                if (highs[i] <= highs[i - k] || highs[i] <= highs[i + k]) isHigh = false;
                if (lows[i] >= lows[i - k] || lows[i] >= lows[i + k]) isLow = false;
            }
            if (isHigh) out.push({ index: i, price: highs[i], type: 'HIGH' });
            if (isLow) out.push({ index: i, price: lows[i], type: 'LOW' });
        }
    }
    return out;
}

// ─── 2. Market structure bias from swing sequence (HH+HL or LL+LH) ──────────
// Uses the last 6 chronological swing points to determine overall direction.
// Intentionally does NOT require the latest swing to be a high/low — entries
// often happen during pullbacks where the most recent swing IS a low (for longs).
// Position-independent: confirms structure from both highs AND lows series.
export function detectBias(swings: SwingPoint[]): Bias {
    const sorted = [...swings].sort((a, b) => a.index - b.index);
    const recent = sorted.slice(-6);

    const highs = recent.filter(s => s.type === 'HIGH');
    const lows = recent.filter(s => s.type === 'LOW');
    if (highs.length < 2 || lows.length < 2) return 'NEUTRAL';

    const lastHigh = highs[highs.length - 1];
    const prevHigh = highs[highs.length - 2];
    const lastLow = lows[lows.length - 1];
    const prevLow = lows[lows.length - 2];

    // BULLISH: highs trending up AND lows trending up (HH + HL)
    const bullish = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;

    // BEARISH: highs trending down AND lows trending down (LH + LL)
    const bearish = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;

    if (bullish) return 'BULLISH';
    if (bearish) return 'BEARISH';
    return 'NEUTRAL';
}

// ─── 3. FVG detection (3-candle imbalance) ──────────────────────────────────
export function findFVGs(
    highs: number[], lows: number[],
    side: 'BULLISH' | 'BEARISH',
    maxAgeFromEnd: number = 20
): FVG[] {
    const out: FVG[] = [];
    const start = Math.max(2, highs.length - maxAgeFromEnd);
    for (let i = start; i < highs.length; i++) {
        if (side === 'BULLISH' && lows[i] > highs[i - 2]) {
            out.push({ index: i, top: lows[i], bottom: highs[i - 2], side: 'BULLISH' });
        } else if (side === 'BEARISH' && highs[i] < lows[i - 2]) {
            out.push({ index: i, top: lows[i - 2], bottom: highs[i], side: 'BEARISH' });
        }
    }
    return out;
}

// ─── 4. Mitigation check: has price CLOSED past the FVG since formation? ────
// Close-based mitigation: wicks don't invalidate, only closes do. More lenient
// than wick-based — plans stay valid longer, fewer churns from volatile wicks.
export function isFVGUnmitigated(fvg: FVG, closes: number[]): boolean {
    for (let i = fvg.index + 1; i < closes.length; i++) {
        if (fvg.side === 'BULLISH' && closes[i] < fvg.bottom) return false;
        if (fvg.side === 'BEARISH' && closes[i] > fvg.top) return false;
    }
    return true;
}

// ─── 5. Price-in-zone (mitigation entry trigger) ────────────────────────────
export function priceInZone(price: number, zone: Zone): boolean {
    return price >= zone.bottom && price <= zone.top;
}

// ─── 6. Liquidity sweep: stop-hunt then reclaim ─────────────────────────────
// For LONG: a recent candle wicked below ANY prior swing low (within lookback)
// AND closed back above it. Same logic mirrored for SHORT against swing highs.
// Returns the swept price level (swing low/high that was hunted) so callers
// can use it as a tight structural SL. Returns null if no sweep found.
export function detectLiquiditySweep(
    swings: SwingPoint[],
    highs: number[], lows: number[], closes: number[],
    side: 'LONG' | 'SHORT',
    recentBars: number = 5,
    sweepLookbackBars: number = 25
): number | null {
    const currentIdx = highs.length - 1;
    const cutoff = currentIdx - recentBars;
    const oldest = currentIdx - sweepLookbackBars;

    if (side === 'LONG') {
        const oldLows = swings.filter(s =>
            s.type === 'LOW' && s.index < cutoff && s.index >= oldest
        );
        if (oldLows.length === 0) return null;
        for (const oldLow of oldLows) {
            for (let i = Math.max(0, cutoff + 1); i <= currentIdx; i++) {
                if (lows[i] < oldLow.price && closes[i] > oldLow.price) return oldLow.price;
            }
        }
    } else {
        const oldHighs = swings.filter(s =>
            s.type === 'HIGH' && s.index < cutoff && s.index >= oldest
        );
        if (oldHighs.length === 0) return null;
        for (const oldHigh of oldHighs) {
            for (let i = Math.max(0, cutoff + 1); i <= currentIdx; i++) {
                if (highs[i] > oldHigh.price && closes[i] < oldHigh.price) return oldHigh.price;
            }
        }
    }
    return null;
}

// ─── 7. Order Block: last opposing candle before the FVG-creating impulse ───
export function findOrderBlock(
    opens: number[], closes: number[], highs: number[], lows: number[],
    fvgIdx: number,
    side: 'BULLISH' | 'BEARISH',
    maxLookback: number = 5
): Zone | null {
    for (let i = fvgIdx - 1; i >= Math.max(0, fvgIdx - maxLookback); i--) {
        const isBearish = closes[i] < opens[i];
        if (side === 'BULLISH' && isBearish) return { top: highs[i], bottom: lows[i] };
        if (side === 'BEARISH' && !isBearish) return { top: highs[i], bottom: lows[i] };
    }
    return null;
}

// ─── 8. Zone overlap (for OB+FVG confluence check) ──────────────────────────
export function zonesOverlap(a: Zone, b: Zone): boolean {
    return !(a.top < b.bottom || a.bottom > b.top);
}

// ─── 9. Displacement (impulsive candle: large body in trend direction) ──────
export function hasDisplacement(
    open: number, close: number, high: number, low: number,
    side: 'BULLISH' | 'BEARISH',
    minBodyRatio: number = 0.5
): boolean {
    const range = high - low;
    if (range === 0) return false;
    const body = Math.abs(close - open);
    if (body / range < minBodyRatio) return false;
    return side === 'BULLISH' ? close > open : close < open;
}

// ─── 9b. Displacement with volume confirmation ───────────────────────────────
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

// ─── 10. Kill zone: London + NY sessions (skip Asian consolidation) ────────
// London 07:00-12:00 UTC, NY 12:00-21:00 UTC.
export function isKillZone(now: Date = new Date()): boolean {
    const hour = now.getUTCHours();
    return hour >= 7 && hour < 21;
}

// ─── 11. Inducement: minor liquidity between entry and target ─────────────
// Smart money typically tags intermediate swing liquidity before driving price
// to the real target. If such liquidity exists between us and TP, the trade
// risks being stopped out during the inducement grab.
//
// For LONG: any LTF swing HIGH strictly between entry and TP is inducement.
// For SHORT: any LTF swing LOW strictly between entry and TP is inducement.
// minInducementBars: ignore very recent swings that may just be entry-area noise.
export function hasInducement(
    swings: SwingPoint[],
    side: 'LONG' | 'SHORT',
    entryPrice: number,
    tpPrice: number,
    currentIdx: number = -1,
    minInducementBars: number = 0
): boolean {
    const matureSwings = currentIdx >= 0
        ? swings.filter(s => s.index < currentIdx - minInducementBars)
        : swings;

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

// ─── 12. Multiple structural TP levels (for multi-tier exits) ──────────────
// Returns swing liquidity targets sorted from NEAREST to FARTHEST relative to entry.
export function structuralTPLevels(
    swings: SwingPoint[],
    side: 'LONG' | 'SHORT',
    currentPrice: number,
    count: number = 2
): number[] {
    if (side === 'LONG') {
        return swings
            .filter(s => s.type === 'HIGH' && s.price > currentPrice)
            .map(s => s.price)
            .sort((a, b) => a - b)        // ascending: nearest first
            .slice(0, count);
    } else {
        return swings
            .filter(s => s.type === 'LOW' && s.price < currentPrice)
            .map(s => s.price)
            .sort((a, b) => b - a)        // descending: nearest first
            .slice(0, count);
    }
}

// ─── 13. Average True Range (ATR) calculation ──────────────────────────────
// Uses Wilder's smoothed RMA (same as Pine Script's rma()).
// Returns the latest ATR value for the given period.
export function calculateATR(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number = 14
): number {
    if (highs.length < period + 1) return 0;

    const trValues: number[] = [];
    for (let i = 1; i < highs.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const prevClose = closes[i - 1];
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trValues.push(tr);
    }

    // RMA (Wilder's smoothing) – same as Pine Script's rma()
    const alpha = 1 / period;
    let atr = trValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trValues.length; i++) {
        atr = (trValues[i] - atr) * alpha + atr;
    }
    return atr;
}

// ─── 14. Multi-timeframe FVG detection ─────────────────────────────────────
// Finds LTF FVGs that are inside a valid HTF FVG zone.
// Returns the LTF FVG that is closest to currentPrice, or null if none found.
export function findMultiTimeframeFVG(
    ltfHighs: number[],
    ltfLows: number[],
    ltfCloses: number[],
    htfHighs: number[],
    htfLows: number[],
    htfCloses: number[],
    side: 'BULLISH' | 'BEARISH',
    currentPrice: number,
    ltfMaxAge: number = 30,
    htfMaxAge: number = 50,
    requireUnmitigated: boolean = true
): FVG | null {
    // 1. Find HTF FVGs
    const htfFvgs = findFVGs(htfHighs, htfLows, side, htfMaxAge);
    const validHtfFvgs = requireUnmitigated
        ? htfFvgs.filter(f => isFVGUnmitigated(f, htfCloses))
        : htfFvgs;

    if (validHtfFvgs.length === 0) return null;

    // 2. Find LTF FVGs
    const ltfFvgs = findFVGs(ltfHighs, ltfLows, side, ltfMaxAge);
    const validLtfFvgs = requireUnmitigated
        ? ltfFvgs.filter(f => isFVGUnmitigated(f, ltfCloses))
        : ltfFvgs;

    if (validLtfFvgs.length === 0) return null;

    // 3. Find LTF FVGs that overlap with any HTF FVG
    const overlapping: FVG[] = [];
    for (const ltfFvg of validLtfFvgs) {
        for (const htfFvg of validHtfFvgs) {
            if (zonesOverlap(ltfFvg, htfFvg)) {
                overlapping.push(ltfFvg);
                break;
            }
        }
    }

    if (overlapping.length === 0) return null;

    // 4. Return the one closest to currentPrice
    overlapping.sort((a, b) => {
        const midA = (a.top + a.bottom) / 2;
        const midB = (b.top + b.bottom) / 2;
        return Math.abs(midA - currentPrice) - Math.abs(midB - currentPrice);
    });

    return overlapping[0];
}

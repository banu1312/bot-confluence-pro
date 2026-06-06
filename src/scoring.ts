import {
    MarketData, SwingPoint, Bias, FVG,
    findSwings, detectBias, findFVGs, isFVGUnmitigated, priceInZone,
    detectLiquiditySweep, findOrderBlock, findOrderBlockWithATR, zonesOverlap,
    hasDisplacementWithVolume, isKillZone, structuralTPLevels, hasInducement,
    findMultiTimeframeFVG, findMultiTimeframeFVG_TopDown, calculateATR
} from './smc';

// Tunable confluence requirements. Toggle individual gates without recompiling logic.
// PRESET: "Sniper RR" — relaxed gates + high RR threshold for high-reward setups.

// Environment variable overrides for all SMC_CONFIG parameters
const REQUIRE_MTF_FVG = process.env.REQUIRE_MTF_FVG === 'true' || process.env.REQUIRE_MTF_FVG === undefined;
const REQUIRE_STRUCTURE_BIAS = process.env.REQUIRE_STRUCTURE_BIAS !== 'false';
const REQUIRE_4H_BIAS = process.env.REQUIRE_4H_BIAS !== 'false';
const REQUIRE_UNMITIGATED = process.env.REQUIRE_UNMITIGATED !== 'false';
const REQUIRE_LIQUIDITY_SWEEP = process.env.REQUIRE_LIQUIDITY_SWEEP !== 'false';
const REQUIRE_DISPLACEMENT = process.env.REQUIRE_DISPLACEMENT !== 'false';
const REQUIRE_OB_CONFLUENCE = process.env.REQUIRE_OB_CONFLUENCE === 'true';
const REQUIRE_NO_INDUCEMENT = true; // Hard filter
const KILL_ZONE_ONLY = process.env.KILL_ZONE_ONLY === 'true';
const MIN_RR = parseFloat(process.env.MIN_RR || '3');
const TP_COUNT = parseInt(process.env.TP_COUNT || '2', 10);
const SL_BUFFER_PCT = parseFloat(process.env.SL_BUFFER_PCT || '0.002');
const MIN_FVG_AGE = parseInt(process.env.MIN_FVG_AGE || '1', 10);
const LTF_FVG_MAX_AGE = parseInt(process.env.LTF_FVG_MAX_AGE || '30', 10);
const HTF_FVG_MAX_AGE = parseInt(process.env.HTF_FVG_MAX_AGE || '50', 10);

// Additional SMC parameters
const HTF_4H_SWING_LOOKBACK = parseInt(process.env.HTF_4H_SWING_LOOKBACK || '5', 10);
const HTF_SWING_LOOKBACK = parseInt(process.env.HTF_SWING_LOOKBACK || '3', 10);
const LTF_SWING_LOOKBACK = parseInt(process.env.LTF_SWING_LOOKBACK || '2', 10);
const SWEEP_WINDOW = parseInt(process.env.SWEEP_WINDOW || '5', 10);
const SWEEP_LOOKBACK_BARS = parseInt(process.env.SWEEP_LOOKBACK_BARS || '25', 10);
const OB_LOOKBACK = parseInt(process.env.OB_LOOKBACK || '5', 10);
const MIN_INDUCEMENT_BARS = parseInt(process.env.MIN_INDUCEMENT_BARS || '2', 10);
const DISPLACEMENT_MIN_BODY = parseFloat(process.env.DISPLACEMENT_MIN_BODY || '0.5');
const DISPLACEMENT_MIN_VOL_MULTIPLIER = parseFloat(process.env.DISPLACEMENT_MIN_VOL_MULTIPLIER || '1.0');

export const SMC_CONFIG = {
    requireStructureBias: REQUIRE_STRUCTURE_BIAS,    // HTF 1H must be HH-HL (LONG) or LH-LL (SHORT)
    require4hBias: REQUIRE_4H_BIAS,           // 4H must not contradict 1H bias
    requireUnmitigated: REQUIRE_UNMITIGATED,      // skip already-filled FVGs
    requireLiquiditySweep: REQUIRE_LIQUIDITY_SWEEP,   // RE-ENABLED — quality > quantity
    requireDisplacement: REQUIRE_DISPLACEMENT,     // FVG-creating candle must be impulsive
    requireOBConfluence: REQUIRE_OB_CONFLUENCE,    // RELAXED — confluence nice but not essential
    requireNoInducement: REQUIRE_NO_INDUCEMENT,    // disabled until signal frequency is sufficient
    requireMultiTimeframeFVG: REQUIRE_MTF_FVG, // NEW: require LTF FVG inside HTF FVG (env: REQUIRE_MTF_FVG)
    killZoneOnly: KILL_ZONE_ONLY,           // only trade London/NY sessions (default OFF)

    htf4hSwingLookback: HTF_4H_SWING_LOOKBACK,
    htfSwingLookback: HTF_SWING_LOOKBACK,
    ltfSwingLookback: LTF_SWING_LOOKBACK,
    htfFvgMaxAge: HTF_FVG_MAX_AGE,              // 1H bars to scan back for HTF FVG
    ltfFvgMaxAge: LTF_FVG_MAX_AGE,              // 5m bars to scan back for LTF FVG
    sweepWindow: SWEEP_WINDOW,
    sweepLookbackBars: SWEEP_LOOKBACK_BARS,         // how far back to scan for liquidity targets
    obLookback: OB_LOOKBACK,
    minInducementBars: MIN_INDUCEMENT_BARS,          // ignore very recent swings near entry zone
    displacementMinBody: DISPLACEMENT_MIN_BODY,
    displacementMinVolMultiplier: DISPLACEMENT_MIN_VOL_MULTIPLIER,
    slBufferPct: SL_BUFFER_PCT,            // 0.2% buffer beyond FVG edge for SL
    minRR: MIN_RR,                      // higher bar = only high-conviction setups fire
    tpCount: TP_COUNT,                    // number of TP tiers
    minFvgAge: MIN_FVG_AGE,                  // FVG must be at least N bars old before triggering entry
};

export interface SMCSignal {
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    slPrice: number;
    tpLevels: number[];            // sorted nearest → farthest
    tpPrice: number;               // farthest TP (used for RR validation + backward compat)
    confluence: string[];
    ltfTimeframe: '5m' | '15m';   // which LTF triggered the signal
    data?: MarketData;             // market data snapshot for ATR calculation in execution
}

export class ScoringEngine {
    // Diagnostic gate rejection counters (reset per backtest run)
    public static gateStats: Record<string, number> = {};
    public static resetStats() { ScoringEngine.gateStats = {}; }
    private static reject(gate: string): null {
        ScoringEngine.gateStats[gate] = (ScoringEngine.gateStats[gate] ?? 0) + 1;
        return null;
    }

    public static evaluateSMCMTF(
        symbol: string,
        data: MarketData,
        ltfTimeframe: '5m' | '15m' = '5m'
    ): SMCSignal | null {
        const ltfCloses = ltfTimeframe === '5m' ? data.closes5m : data.closes15m;
        if (data.closes1h.length < 20 || ltfCloses.length < 20) return this.reject('DATA_SHORT');

        const currentPrice = ltfCloses[ltfCloses.length - 1];

        // Gate 0: Session timing
        if (SMC_CONFIG.killZoneOnly && !isKillZone()) return this.reject('KILL_ZONE');

        // Gate 1a: 4H HTF bias filter — major timeframe must align
        const htf4hSwings = findSwings(data.highs4h, data.lows4h, SMC_CONFIG.htf4hSwingLookback);
        const bias4h = detectBias(htf4hSwings);

        // Gate 1b: 1H bias
        const htfSwings = findSwings(data.highs1h, data.lows1h, SMC_CONFIG.htfSwingLookback);
        const bias1h = detectBias(htfSwings);

        // Combined: if require4hBias, reject only when 4H has a clear opinion that contradicts 1H.
        // 4H NEUTRAL means "no clear structure yet" — defer to 1H, do not reject.
        if (SMC_CONFIG.require4hBias) {
            if (bias4h !== 'NEUTRAL' && bias1h !== 'NEUTRAL' && bias4h !== bias1h) return this.reject('BIAS_4H_1H_CONFLICT');
        }

        // Final bias = 4H (master), fall back to 1H if 4H neutral & require4hBias=false
        const bias: Bias = bias4h !== 'NEUTRAL' ? bias4h : bias1h;

        if (SMC_CONFIG.requireStructureBias && bias === 'NEUTRAL') return this.reject('BIAS_NEUTRAL');

        // Bias dictates which side(s) we even consider
        const sides: ('LONG' | 'SHORT')[] = [];
        if (!SMC_CONFIG.requireStructureBias || bias === 'BULLISH') sides.push('LONG');
        if (!SMC_CONFIG.requireStructureBias || bias === 'BEARISH') sides.push('SHORT');

        for (const side of sides) {
            const signal = this.evaluateSide(symbol, data, side, currentPrice, htfSwings, htf4hSwings, bias, ltfTimeframe);
            if (signal) return signal;
        }
        return null;
    }

    private static evaluateSide(
        symbol: string,
        data: MarketData,
        side: 'LONG' | 'SHORT',
        currentPrice: number,
        htfSwings: SwingPoint[],
        htf4hSwings: SwingPoint[],
        bias: Bias,
        ltfTimeframe: '5m' | '15m'
    ): SMCSignal | null {
        const ltfOpens   = ltfTimeframe === '5m' ? data.opens5m   : data.opens15m;
        const ltfHighs   = ltfTimeframe === '5m' ? data.highs5m   : data.highs15m;
        const ltfLows    = ltfTimeframe === '5m' ? data.lows5m    : data.lows15m;
        const ltfCloses  = ltfTimeframe === '5m' ? data.closes5m  : data.closes15m;
        const ltfVolumes = ltfTimeframe === '5m' ? data.volumes5m : data.volumes15m;
        const fvgSide: 'BULLISH' | 'BEARISH' = side === 'LONG' ? 'BULLISH' : 'BEARISH';
        const confluence: string[] = [`BIAS=${bias}`];

        // Gate 2: HTF FVG magnet zone — must contain currentPrice + (optionally) unmitigated
        const currentIdx1h = data.closes1h.length - 1;
        const htfFvgs = findFVGs(data.highs1h, data.lows1h, fvgSide, SMC_CONFIG.htfFvgMaxAge);
        const validHtfFvgs = (SMC_CONFIG.requireUnmitigated
            ? htfFvgs.filter(f => isFVGUnmitigated(f, data.closes1h))
            : htfFvgs
        ).filter(f => (currentIdx1h - f.index) >= SMC_CONFIG.minFvgAge);
        const htfFvg = validHtfFvgs.find(f => priceInZone(currentPrice, f));
        if (!htfFvg) return ScoringEngine.reject('NO_HTF_FVG');
        confluence.push('HTF_FVG');

        // Gate 3: Liquidity sweep on LTF (stop-hunt + reclaim)
        // detectLiquiditySweep returns the swept swing price — used as structural SL.
        const ltfSwings = findSwings(ltfHighs, ltfLows, SMC_CONFIG.ltfSwingLookback);
        const sweptLevel = detectLiquiditySweep(
            ltfSwings,
            ltfHighs, ltfLows, ltfCloses,
            side, SMC_CONFIG.sweepWindow, SMC_CONFIG.sweepLookbackBars
        );
        if (SMC_CONFIG.requireLiquiditySweep && sweptLevel === null) return ScoringEngine.reject('NO_SWEEP');
        if (sweptLevel !== null) confluence.push('LIQ_SWEEP');

        // Gate 4: LTF FVG entry trigger (with multi-timeframe validation)
        const currentIdxLtf = ltfCloses.length - 1;
        let ltfFvg: FVG | null = null;

        if (SMC_CONFIG.requireMultiTimeframeFVG) {
            // Gunakan Top-Down MTF
            ltfFvg = findMultiTimeframeFVG_TopDown(
                ltfHighs, ltfLows, ltfCloses,
                data.highs1h, data.lows1h, data.closes1h, data.opens1h,
                fvgSide, currentPrice,
                SMC_CONFIG.ltfFvgMaxAge,
                SMC_CONFIG.htfFvgMaxAge,
                SMC_CONFIG.requireUnmitigated
            );
        } else {
            // Fallback to single-timeframe detection
            const ltfFvgs = findFVGs(ltfHighs, ltfLows, fvgSide, SMC_CONFIG.ltfFvgMaxAge);
            const validLtfFvgs = (SMC_CONFIG.requireUnmitigated
                ? ltfFvgs.filter(f => isFVGUnmitigated(f, ltfCloses))
                : ltfFvgs
            ).filter(f => (currentIdxLtf - f.index) >= SMC_CONFIG.minFvgAge);
            ltfFvg = validLtfFvgs.find(f => priceInZone(currentPrice, f)) ?? null;
        }

        if (!ltfFvg) return ScoringEngine.reject('NO_LTF_FVG');
        confluence.push(`LTF_FVG_${ltfTimeframe}`);
        if (SMC_CONFIG.requireMultiTimeframeFVG) confluence.push('MTF_FVG');

        // Gate 5: Displacement + volume — FVG candle must be impulsive AND volume-backed
        if (SMC_CONFIG.requireDisplacement) {
            const fvgIdx = ltfFvg.index;
            const lookback = 20;
            const volWindow = ltfVolumes.slice(Math.max(0, fvgIdx - lookback), fvgIdx);
            const avgVol = volWindow.reduce((a, b) => a + b, 0) / Math.max(1, volWindow.length);

            const dispFvg = hasDisplacementWithVolume(
                ltfOpens[fvgIdx], ltfCloses[fvgIdx],
                ltfHighs[fvgIdx], ltfLows[fvgIdx],
                ltfVolumes[fvgIdx], avgVol,
                fvgSide, SMC_CONFIG.displacementMinBody, SMC_CONFIG.displacementMinVolMultiplier
            );
            if (!dispFvg) return ScoringEngine.reject('NO_DISPLACEMENT_VOL');
            confluence.push('DISPLACEMENT_VOL');
        }

        // Gate 6: Order Block confluence with LTF FVG (dengan ATR buffer)
        if (SMC_CONFIG.requireOBConfluence) {
            // Hitung ATR untuk LTF
            const atr = calculateATR(ltfHighs, ltfLows, ltfCloses, 14);
            if (atr === 0) return ScoringEngine.reject('NO_ATR');

            const ob = findOrderBlockWithATR(
                ltfOpens, ltfCloses, ltfHighs, ltfLows,
                ltfFvg.index, fvgSide, atr, 0.5, SMC_CONFIG.obLookback
            );
            if (!ob || !zonesOverlap(ob, ltfFvg)) return ScoringEngine.reject('NO_OB');
            confluence.push('OB');
        }

        // SL: LTF FVG edge (robust structural level — survives normal volatility).
        // sweptLevel is retained for signal diagnostics but not used as SL (too tight
        // for intrabar noise on liquid coins; causes immediate stop-outs).
        const sl = side === 'LONG'
            ? ltfFvg.bottom * (1 - SMC_CONFIG.slBufferPct)
            : ltfFvg.top * (1 + SMC_CONFIG.slBufferPct);

        // TP: nearest → farthest 1H structural swing liquidity in the trade direction.
        // 1H swings give achievable targets (5-30 bars), with TP2 as the runner.
        // Trail factor 0.8 locks 80% of TP1 gain on the remaining position if TP2 isn't reached.
        const tpLevels = structuralTPLevels(htfSwings, side, currentPrice, SMC_CONFIG.tpCount);
        if (tpLevels.length === 0) return ScoringEngine.reject('NO_TP');
        const nearTP = tpLevels[0];
        const farTP = tpLevels[tpLevels.length - 1];

        // Gate 7: Inducement — skip if minor LTF liquidity sits between entry and TP1.
        // Smart money will likely tag that liquidity before reaching the real target,
        // risking a stop-out during the inducement grab.
        if (SMC_CONFIG.requireNoInducement) {
            if (hasInducement(ltfSwings, side, currentPrice, nearTP, ltfCloses.length - 1, SMC_CONFIG.minInducementBars)) return ScoringEngine.reject('HAS_INDUCEMENT');
            confluence.push('NO_INDUCEMENT');
        }

        // Gate 8: RR validation — use NEAREST TP for realistic geometry.
        // TP1 should be achievable within 5-20 bars; TP2 is bonus if momentum holds.
        const rr = side === 'LONG'
            ? (nearTP - currentPrice) / (currentPrice - sl)
            : (currentPrice - nearTP) / (sl - currentPrice);
        if (!isFinite(rr) || rr < SMC_CONFIG.minRR) return ScoringEngine.reject('LOW_RR');
        confluence.push(`RR=${rr.toFixed(2)}`);

        const tpListStr = tpLevels.map(t => t.toFixed(4)).join('/');
        console.log(`🎯 [SMC ${ltfTimeframe}] ${symbol} ${side} @ ${currentPrice} | TP=[${tpListStr}] | ${confluence.join(' + ')}`);

        return {
            symbol, side,
            entryPrice: currentPrice,
            slPrice: sl,
            tpLevels,
            tpPrice: farTP,
            confluence,
            ltfTimeframe,
            data
        };
    }
}

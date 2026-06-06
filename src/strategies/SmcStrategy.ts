import { BaseStrategy } from './BaseStrategy';
import {
    MarketData, SwingPoint, Bias, FVG,
    findSwings, detectBias, findFVGs, isFVGUnmitigated, priceInZone,
    detectLiquiditySweep, findOrderBlock, findOrderBlockWithATR, zonesOverlap,
    hasDisplacementWithVolume, isKillZone, structuralTPLevels, hasInducement,
    findMultiTimeframeFVG, findMultiTimeframeFVG_TopDown, calculateATR
} from '../smc';

// Tunable confluence requirements. Toggle individual gates without recompiling logic.
// PRESET: "Sniper RR" — relaxed gates + high RR threshold for high-reward setups.

// Environment variable overrides for all SMC_CONFIG parameters
const REQUIRE_MTF_FVG = process.env.REQUIRE_MTF_FVG === 'true';
const REQUIRE_STRUCTURE_BIAS = process.env.REQUIRE_STRUCTURE_BIAS !== 'false';
const REQUIRE_4H_BIAS = process.env.REQUIRE_4H_BIAS === 'true';
const REQUIRE_UNMITIGATED = process.env.REQUIRE_UNMITIGATED !== 'false';
const REQUIRE_LIQUIDITY_SWEEP = process.env.REQUIRE_LIQUIDITY_SWEEP === 'true';
const REQUIRE_DISPLACEMENT = process.env.REQUIRE_DISPLACEMENT === 'true';
const REQUIRE_OB_CONFLUENCE = process.env.REQUIRE_OB_CONFLUENCE === 'true';
const REQUIRE_NO_INDUCEMENT = true; // Hard filter
const KILL_ZONE_ONLY = process.env.KILL_ZONE_ONLY === 'true';
const MIN_RR = parseFloat(process.env.MIN_RR || '2');
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
    requireStructureBias: REQUIRE_STRUCTURE_BIAS,
    require4hBias: REQUIRE_4H_BIAS,
    requireUnmitigated: REQUIRE_UNMITIGATED,
    requireLiquiditySweep: REQUIRE_LIQUIDITY_SWEEP,
    requireDisplacement: REQUIRE_DISPLACEMENT,
    requireOBConfluence: REQUIRE_OB_CONFLUENCE,
    requireNoInducement: REQUIRE_NO_INDUCEMENT,
    requireMultiTimeframeFVG: REQUIRE_MTF_FVG,
    killZoneOnly: KILL_ZONE_ONLY,

    htf4hSwingLookback: HTF_4H_SWING_LOOKBACK,
    htfSwingLookback: HTF_SWING_LOOKBACK,
    ltfSwingLookback: LTF_SWING_LOOKBACK,
    htfFvgMaxAge: HTF_FVG_MAX_AGE,
    ltfFvgMaxAge: LTF_FVG_MAX_AGE,
    sweepWindow: SWEEP_WINDOW,
    sweepLookbackBars: SWEEP_LOOKBACK_BARS,
    obLookback: OB_LOOKBACK,
    minInducementBars: MIN_INDUCEMENT_BARS,
    displacementMinBody: DISPLACEMENT_MIN_BODY,
    displacementMinVolMultiplier: DISPLACEMENT_MIN_VOL_MULTIPLIER,
    slBufferPct: SL_BUFFER_PCT,
    minRR: MIN_RR,
    tpCount: TP_COUNT,
    minFvgAge: MIN_FVG_AGE,
};

export interface SMCSignal {
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    slPrice: number;
    tpLevels: number[];
    tpPrice: number;
    confluence: string[];
    ltfTimeframe: '5m' | '15m';
    data?: MarketData;
}

export class SmcStrategy implements BaseStrategy {
    name = 'smc';
    public gateStats: Record<string, number> = {};

    private reject(gate: string): null {
        this.gateStats[gate] = (this.gateStats[gate] ?? 0) + 1;
        return null;
    }

    async scanDailyWatchlist(): Promise<string[]> {
        const { Screener } = require('../screener');
        return await Screener.getTopTrendingCoins(20);
    }

    async checkHTFTrigger(symbol: string, candle4h: any): Promise<any> {
        return { triggered: true, candle4h };
    }

    async checkLTFEntry(symbol: string, triggerContext: any, candle15m: any): Promise<any> {
        return null;
    }

    async manageActivePosition(position: any, currentPrice: number, candle4h: any, candle15m: any): Promise<any> {
        return null;
    }

    public evaluateSMCMTF(
        symbol: string,
        data: MarketData,
        ltfTimeframe: '5m' | '15m' = '5m'
    ): SMCSignal | null {
        const ltfCloses = ltfTimeframe === '5m' ? data.closes5m : data.closes15m;
        if (data.closes1h.length < 20 || ltfCloses.length < 20) return this.reject('DATA_SHORT');

        const currentPrice = ltfCloses[ltfCloses.length - 1];

        if (SMC_CONFIG.killZoneOnly && !isKillZone()) return this.reject('KILL_ZONE');

        const htf4hSwings = findSwings(data.highs4h, data.lows4h, SMC_CONFIG.htf4hSwingLookback);
        const bias4h = detectBias(htf4hSwings);

        const htfSwings = findSwings(data.highs1h, data.lows1h, SMC_CONFIG.htfSwingLookback);
        const bias1h = detectBias(htfSwings);

        if (SMC_CONFIG.require4hBias) {
            if (bias4h !== 'NEUTRAL' && bias1h !== 'NEUTRAL' && bias4h !== bias1h) return this.reject('BIAS_4H_1H_CONFLICT');
        }

        const bias: Bias = bias4h !== 'NEUTRAL' ? bias4h : bias1h;

        if (SMC_CONFIG.requireStructureBias && bias === 'NEUTRAL') return this.reject('BIAS_NEUTRAL');

        const sides: ('LONG' | 'SHORT')[] = [];
        if (!SMC_CONFIG.requireStructureBias || bias === 'BULLISH') sides.push('LONG');
        if (!SMC_CONFIG.requireStructureBias || bias === 'BEARISH') sides.push('SHORT');

        for (const side of sides) {
            const signal = this.evaluateSide(symbol, data, side, currentPrice, htfSwings, htf4hSwings, bias, ltfTimeframe);
            if (signal) return signal;
        }
        return null;
    }

    private evaluateSide(
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

        const currentIdx1h = data.closes1h.length - 1;
        const htfFvgs = findFVGs(data.highs1h, data.lows1h, fvgSide, SMC_CONFIG.htfFvgMaxAge);
        const validHtfFvgs = (SMC_CONFIG.requireUnmitigated
            ? htfFvgs.filter(f => isFVGUnmitigated(f, data.closes1h))
            : htfFvgs
        ).filter(f => (currentIdx1h - f.index) >= SMC_CONFIG.minFvgAge);
        const htfFvg = validHtfFvgs.find(f => priceInZone(currentPrice, f));
        if (!htfFvg) return this.reject('NO_HTF_FVG');
        confluence.push('HTF_FVG');

        const ltfSwings = findSwings(ltfHighs, ltfLows, SMC_CONFIG.ltfSwingLookback);
        const sweptLevel = detectLiquiditySweep(
            ltfSwings,
            ltfHighs, ltfLows, ltfCloses,
            side, SMC_CONFIG.sweepWindow, SMC_CONFIG.sweepLookbackBars
        );
        if (SMC_CONFIG.requireLiquiditySweep && sweptLevel === null) return this.reject('NO_SWEEP');
        if (sweptLevel !== null) confluence.push('LIQ_SWEEP');

        const currentIdxLtf = ltfCloses.length - 1;
        let ltfFvg: FVG | null = null;

        if (SMC_CONFIG.requireMultiTimeframeFVG) {
            ltfFvg = findMultiTimeframeFVG_TopDown(
                ltfHighs, ltfLows, ltfCloses,
                data.highs1h, data.lows1h, data.closes1h, data.opens1h,
                fvgSide, currentPrice,
                SMC_CONFIG.ltfFvgMaxAge,
                SMC_CONFIG.htfFvgMaxAge,
                SMC_CONFIG.requireUnmitigated
            );
        } else {
            const ltfFvgs = findFVGs(ltfHighs, ltfLows, fvgSide, SMC_CONFIG.ltfFvgMaxAge);
            const validLtfFvgs = (SMC_CONFIG.requireUnmitigated
                ? ltfFvgs.filter(f => isFVGUnmitigated(f, ltfCloses))
                : ltfFvgs
            ).filter(f => (currentIdxLtf - f.index) >= SMC_CONFIG.minFvgAge);
            ltfFvg = validLtfFvgs.find(f => priceInZone(currentPrice, f)) ?? null;
        }

        if (!ltfFvg) return this.reject('NO_LTF_FVG');
        confluence.push(`LTF_FVG_${ltfTimeframe}`);
        if (SMC_CONFIG.requireMultiTimeframeFVG) confluence.push('MTF_FVG');

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
            if (!dispFvg) return this.reject('NO_DISPLACEMENT_VOL');
            confluence.push('DISPLACEMENT_VOL');
        }

        if (SMC_CONFIG.requireOBConfluence) {
            const atr = calculateATR(ltfHighs, ltfLows, ltfCloses, 14);
            if (atr === 0) return this.reject('NO_ATR');

            const ob = findOrderBlockWithATR(
                ltfOpens, ltfCloses, ltfHighs, ltfLows,
                ltfFvg.index, fvgSide, atr, 0.5, SMC_CONFIG.obLookback
            );
            if (!ob || !zonesOverlap(ob, ltfFvg)) return this.reject('NO_OB');
            confluence.push('OB');
        }

        const sl = side === 'LONG'
            ? ltfFvg.bottom * (1 - SMC_CONFIG.slBufferPct)
            : ltfFvg.top * (1 + SMC_CONFIG.slBufferPct);

        const tpLevels = structuralTPLevels(htfSwings, side, currentPrice, SMC_CONFIG.tpCount);
        if (tpLevels.length === 0) return this.reject('NO_TP');
        const nearTP = tpLevels[0];
        const farTP = tpLevels[tpLevels.length - 1];

        if (SMC_CONFIG.requireNoInducement) {
            if (hasInducement(ltfSwings, side, currentPrice, nearTP, ltfCloses.length - 1, SMC_CONFIG.minInducementBars)) return this.reject('HAS_INDUCEMENT');
            confluence.push('NO_INDUCEMENT');
        }

        const rr = side === 'LONG'
            ? (nearTP - currentPrice) / (currentPrice - sl)
            : (currentPrice - nearTP) / (sl - currentPrice);
        if (!isFinite(rr) || rr < SMC_CONFIG.minRR) return this.reject('LOW_RR');
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

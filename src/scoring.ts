import {
    MarketData, SwingPoint, Bias, FVG,
    findSwings, detectBias, findFVGs, isFVGUnmitigated, priceInZone,
    detectLiquiditySweep, findOrderBlock, findOrderBlockWithATR, zonesOverlap,
    hasDisplacementWithVolume, isKillZone, structuralTPLevels, hasInducement,
    findMultiTimeframeFVG, findMultiTimeframeFVG_TopDown, calculateATR
} from './smc';
import { SmcStrategy, SMCSignal, SMC_CONFIG } from './strategies/SmcStrategy';

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

const smcStrategyInstance = new SmcStrategy();

export { SMC_CONFIG };

export class ScoringEngine {
    // Diagnostic gate rejection counters (reset per backtest run)
    public static gateStats: Record<string, number> = {};
    public static resetStats() { 
        ScoringEngine.gateStats = {}; 
        smcStrategyInstance.gateStats = {};
    }
    private static reject(gate: string): null {
        ScoringEngine.gateStats[gate] = (ScoringEngine.gateStats[gate] ?? 0) + 1;
        return null;
    }

    public static evaluateSMCMTF(
        symbol: string,
        data: MarketData,
        ltfTimeframe: '5m' | '15m' = '5m'
    ): SMCSignal | null {
        return smcStrategyInstance.evaluateSMCMTF(symbol, data, ltfTimeframe);
    }
}

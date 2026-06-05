import { ScoringEngine, SMC_CONFIG, SMCSignal } from '../scoring';
import { MarketData } from '../smc';

// ─── Helper untuk membuat MarketData dummy ──────────────────────────────────
function makeMarketData(
  closes5m: number[],
  closes15m: number[],
  closes1h: number[],
  closes4h: number[],
  opens5m?: number[],
  highs5m?: number[],
  lows5m?: number[],
  volumes5m?: number[],
  opens15m?: number[],
  highs15m?: number[],
  lows15m?: number[],
  volumes15m?: number[],
  opens1h?: number[],
  highs1h?: number[],
  lows1h?: number[],
  volumes1h?: number[],
  opens4h?: number[],
  highs4h?: number[],
  lows4h?: number[],
  volumes4h?: number[],
): MarketData {
  const n5 = closes5m.length;
  const n15 = closes15m.length;
  const n1 = closes1h.length;
  const n4 = closes4h.length;

  return {
    opens5m: opens5m ?? closes5m.map(c => c - 0.1),
    highs5m: highs5m ?? closes5m.map(c => c + 0.2),
    lows5m: lows5m ?? closes5m.map(c => c - 0.2),
    closes5m,
    volumes5m: volumes5m ?? closes5m.map(() => 1000),
    lastTs5m: String(Date.now()),
    opens15m: opens15m ?? closes15m.map(c => c - 0.1),
    highs15m: highs15m ?? closes15m.map(c => c + 0.2),
    lows15m: lows15m ?? closes15m.map(c => c - 0.2),
    closes15m,
    volumes15m: volumes15m ?? closes15m.map(() => 1000),
    lastTs15m: String(Date.now()),
    opens1h: opens1h ?? closes1h.map(c => c - 0.1),
    highs1h: highs1h ?? closes1h.map(c => c + 0.2),
    lows1h: lows1h ?? closes1h.map(c => c - 0.2),
    closes1h,
    volumes1h: volumes1h ?? closes1h.map(() => 1000),
    lastTs1h: String(Date.now()),
    opens4h: opens4h ?? closes4h.map(c => c - 0.1),
    highs4h: highs4h ?? closes4h.map(c => c + 0.2),
    lows4h: lows4h ?? closes4h.map(c => c - 0.2),
    closes4h,
    volumes4h: volumes4h ?? closes4h.map(() => 1000),
    lastTs4h: String(Date.now()),
  };
}

// ─── ScoringEngine ──────────────────────────────────────────────────────────
describe('ScoringEngine', () => {
  beforeEach(() => {
    ScoringEngine.resetStats();
  });

  it('should return null when data is too short', () => {
    const data = makeMarketData(
      [100, 101], // closes5m (only 2)
      [100, 101], // closes15m
      [100, 101], // closes1h
      [100, 101], // closes4h
    );
    const signal = ScoringEngine.evaluateSMCMTF('BTCUSDT', data, '5m');
    expect(signal).toBeNull();
    expect(ScoringEngine.gateStats['DATA_SHORT']).toBe(1);
  });

  it('should return null when bias is NEUTRAL and requireStructureBias is true', () => {
    // Create data with no clear structure (all prices flat)
    const closes5m = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 0.5);
    const closes15m = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 2) * 0.5);
    const closes1h = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3) * 0.5);
    const closes4h = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 4) * 0.5);

    const data = makeMarketData(closes5m, closes15m, closes1h, closes4h);
    const signal = ScoringEngine.evaluateSMCMTF('BTCUSDT', data, '5m');
    // Might be null due to BIAS_NEUTRAL or other gates
    // We just verify it doesn't crash
    expect(signal).toBeNull();
  });

  it('should return null when no HTF FVG zone contains current price', () => {
    // Create data where price is far from any FVG
    const closes5m = Array.from({ length: 30 }, (_, i) => 100 + i * 0.1);
    const closes15m = Array.from({ length: 30 }, (_, i) => 100 + i * 0.2);
    const closes1h = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    const closes4h = Array.from({ length: 30 }, (_, i) => 100 + i * 1.0);

    const data = makeMarketData(closes5m, closes15m, closes1h, closes4h);
    const signal = ScoringEngine.evaluateSMCMTF('BTCUSDT', data, '5m');
    expect(signal).toBeNull();
  });

  it('should reset gate stats correctly', () => {
    ScoringEngine.resetStats();
    expect(Object.keys(ScoringEngine.gateStats).length).toBe(0);
  });

  it('should handle 15m timeframe without crashing', () => {
    const closes5m = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 2);
    const closes15m = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 2) * 2);
    const closes1h = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 3) * 2);
    const closes4h = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i / 4) * 2);

    const data = makeMarketData(closes5m, closes15m, closes1h, closes4h);
    const signal = ScoringEngine.evaluateSMCMTF('BTCUSDT', data, '15m');
    // Just ensure no crash
    expect(signal).toBeNull();
  });
});

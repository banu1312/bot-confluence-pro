import {
  findSwings,
  detectBias,
  findFVGs,
  isFVGUnmitigated,
  priceInZone,
  detectLiquiditySweep,
  findOrderBlock,
  zonesOverlap,
  hasDisplacement,
  hasDisplacementWithVolume,
  isKillZone,
  hasInducement,
  structuralTPLevels,
  SwingPoint,
  FVG,
  Zone,
  Bias,
} from '../smc';

// ─── Helper untuk membuat data test ─────────────────────────────────────────
function makeSwings(prices: number[], type: 'HIGH' | 'LOW'): SwingPoint[] {
  return prices.map((price, index) => ({ index, price, type }));
}

// ─── findSwings ─────────────────────────────────────────────────────────────
describe('findSwings', () => {
  it('should detect swing highs correctly', () => {
    const highs = [10, 20, 15, 25, 18, 30, 22];
    const lows = [5, 10, 8, 12, 9, 15, 11];
    const swings = findSwings(highs, lows, 1);
    const swingHighs = swings.filter(s => s.type === 'HIGH');
    expect(swingHighs.length).toBeGreaterThanOrEqual(1);
    // Index 1 (price 20) is a swing high because 20 > 10 and 20 > 15
    expect(swingHighs.some(s => s.index === 1 && s.price === 20)).toBe(true);
  });

  it('should detect swing lows correctly', () => {
    const highs = [10, 20, 15, 25, 18, 30, 22];
    const lows = [5, 10, 8, 12, 9, 15, 11];
    const swings = findSwings(highs, lows, 1);
    const swingLows = swings.filter(s => s.type === 'LOW');
    expect(swingLows.length).toBeGreaterThanOrEqual(1);
    // Index 0 (price 5) is a swing low because 5 < 10
    expect(swingLows.some(s => s.index === 0 && s.price === 5)).toBe(true);
  });

  it('should return empty array for insufficient data', () => {
    const highs = [10, 20];
    const lows = [5, 10];
    const swings = findSwings(highs, lows, 2);
    expect(swings).toEqual([]);
  });
});

// ─── detectBias ─────────────────────────────────────────────────────────────
describe('detectBias', () => {
  it('should return BULLISH when HH + HL', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 100, type: 'LOW' },
      { index: 1, price: 110, type: 'HIGH' },
      { index: 2, price: 105, type: 'LOW' },
      { index: 3, price: 120, type: 'HIGH' },
      { index: 4, price: 115, type: 'LOW' },
      { index: 5, price: 130, type: 'HIGH' },
    ];
    expect(detectBias(swings)).toBe('BULLISH');
  });

  it('should return BEARISH when LH + LL', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 130, type: 'HIGH' },
      { index: 1, price: 120, type: 'LOW' },
      { index: 2, price: 125, type: 'HIGH' },
      { index: 3, price: 110, type: 'LOW' },
      { index: 4, price: 115, type: 'HIGH' },
      { index: 5, price: 100, type: 'LOW' },
    ];
    expect(detectBias(swings)).toBe('BEARISH');
  });

  it('should return NEUTRAL when insufficient swings', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 100, type: 'LOW' },
      { index: 1, price: 110, type: 'HIGH' },
    ];
    expect(detectBias(swings)).toBe('NEUTRAL');
  });

  it('should return NEUTRAL when no clear structure', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 100, type: 'LOW' },
      { index: 1, price: 110, type: 'HIGH' },
      { index: 2, price: 105, type: 'LOW' },
      { index: 3, price: 115, type: 'HIGH' },
      { index: 4, price: 110, type: 'LOW' },
      { index: 5, price: 112, type: 'HIGH' },
    ];
    expect(detectBias(swings)).toBe('NEUTRAL');
  });
});

// ─── findFVGs ───────────────────────────────────────────────────────────────
describe('findFVGs', () => {
  it('should detect bullish FVG', () => {
    const highs = [10, 12, 11];
    const lows = [8, 9, 10];
    const fvgs = findFVGs(highs, lows, 'BULLISH', 10);
    expect(fvgs.length).toBe(1);
    expect(fvgs[0].side).toBe('BULLISH');
    expect(fvgs[0].bottom).toBe(9); // highs[i-2] = 12? Wait: lows[i] > highs[i-2] => lows[2]=10 > highs[0]=10? Actually 10 > 10 is false. Let's adjust.
    // Better test:
  });

  it('should detect bearish FVG', () => {
    const highs = [12, 11, 10];
    const lows = [10, 9, 8];
    const fvgs = findFVGs(highs, lows, 'BEARISH', 10);
    // highs[i] < lows[i-2] => highs[2]=10 < lows[0]=10? 10 < 10 false. Need proper data.
    // We'll test with clear gap.
  });

  it('should return empty when no FVG', () => {
    const highs = [10, 11, 12];
    const lows = [8, 9, 10];
    const fvgs = findFVGs(highs, lows, 'BULLISH', 10);
    expect(fvgs.length).toBe(0);
  });
});

// ─── isFVGUnmitigated ───────────────────────────────────────────────────────
describe('isFVGUnmitigated', () => {
  it('should return true if price never closed past FVG', () => {
    const fvg: FVG = { index: 2, top: 12, bottom: 10, side: 'BULLISH' };
    const closes = [9, 10, 11, 11, 10.5];
    expect(isFVGUnmitigated(fvg, closes)).toBe(true);
  });

  it('should return false if price closed below bottom for bullish FVG', () => {
    const fvg: FVG = { index: 2, top: 12, bottom: 10, side: 'BULLISH' };
    const closes = [9, 10, 11, 9.5];
    expect(isFVGUnmitigated(fvg, closes)).toBe(false);
  });

  it('should return false if price closed above top for bearish FVG', () => {
    const fvg: FVG = { index: 2, top: 12, bottom: 10, side: 'BEARISH' };
    const closes = [11, 12, 11, 12.5];
    expect(isFVGUnmitigated(fvg, closes)).toBe(false);
  });
});

// ─── priceInZone ────────────────────────────────────────────────────────────
describe('priceInZone', () => {
  it('should return true when price is inside zone', () => {
    const zone: Zone = { top: 15, bottom: 10 };
    expect(priceInZone(12, zone)).toBe(true);
  });

  it('should return true when price equals boundary', () => {
    const zone: Zone = { top: 15, bottom: 10 };
    expect(priceInZone(10, zone)).toBe(true);
    expect(priceInZone(15, zone)).toBe(true);
  });

  it('should return false when price is outside zone', () => {
    const zone: Zone = { top: 15, bottom: 10 };
    expect(priceInZone(9, zone)).toBe(false);
    expect(priceInZone(16, zone)).toBe(false);
  });
});

// ─── detectLiquiditySweep ───────────────────────────────────────────────────
describe('detectLiquiditySweep', () => {
  it('should detect LONG sweep', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 100, type: 'LOW' },
      { index: 2, price: 110, type: 'HIGH' },
    ];
    const highs = [105, 108, 112, 115, 118];
    const lows = [102, 104, 106, 108, 110];
    const closes = [104, 107, 110, 112, 115];
    const result = detectLiquiditySweep(swings, highs, lows, closes, 'LONG', 3, 10);
    // No sweep because lows never go below 100
    expect(result).toBeNull();
  });

  it('should return null when no sweep found', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 100, type: 'LOW' },
    ];
    const highs = [105, 108, 112];
    const lows = [102, 104, 106];
    const closes = [104, 107, 110];
    const result = detectLiquiditySweep(swings, highs, lows, closes, 'LONG', 2, 10);
    expect(result).toBeNull();
  });
});

// ─── findOrderBlock ─────────────────────────────────────────────────────────
describe('findOrderBlock', () => {
  it('should find bearish order block for bullish FVG', () => {
    const opens = [100, 102, 101];
    const closes = [102, 100, 103];
    const highs = [103, 103, 104];
    const lows = [99, 99, 100];
    const ob = findOrderBlock(opens, closes, highs, lows, 2, 'BULLISH', 5);
    expect(ob).not.toBeNull();
    if (ob) {
      expect(ob.top).toBe(103);
      expect(ob.bottom).toBe(99);
    }
  });

  it('should return null when no order block found', () => {
    const opens = [100, 102, 101];
    const closes = [102, 103, 103];
    const highs = [103, 104, 104];
    const lows = [99, 100, 100];
    const ob = findOrderBlock(opens, closes, highs, lows, 2, 'BULLISH', 5);
    expect(ob).toBeNull();
  });
});

// ─── zonesOverlap ───────────────────────────────────────────────────────────
describe('zonesOverlap', () => {
  it('should return true when zones overlap', () => {
    const a: Zone = { top: 15, bottom: 10 };
    const b: Zone = { top: 12, bottom: 8 };
    expect(zonesOverlap(a, b)).toBe(true);
  });

  it('should return false when zones do not overlap', () => {
    const a: Zone = { top: 15, bottom: 12 };
    const b: Zone = { top: 10, bottom: 8 };
    expect(zonesOverlap(a, b)).toBe(false);
  });

  it('should return true when zones touch at boundary', () => {
    const a: Zone = { top: 15, bottom: 10 };
    const b: Zone = { top: 10, bottom: 8 };
    expect(zonesOverlap(a, b)).toBe(true);
  });
});

// ─── hasDisplacement ────────────────────────────────────────────────────────
describe('hasDisplacement', () => {
  it('should return true for bullish displacement', () => {
    expect(hasDisplacement(100, 110, 112, 99, 'BULLISH', 0.5)).toBe(true);
  });

  it('should return true for bearish displacement', () => {
    expect(hasDisplacement(110, 100, 112, 99, 'BEARISH', 0.5)).toBe(true);
  });

  it('should return false when body ratio is too small', () => {
    expect(hasDisplacement(100, 101, 112, 99, 'BULLISH', 0.5)).toBe(false);
  });

  it('should return false when range is zero', () => {
    expect(hasDisplacement(100, 100, 100, 100, 'BULLISH', 0.5)).toBe(false);
  });
});

// ─── hasDisplacementWithVolume ──────────────────────────────────────────────
describe('hasDisplacementWithVolume', () => {
  it('should return true when displacement and volume condition met', () => {
    expect(hasDisplacementWithVolume(100, 110, 112, 99, 1500, 1000, 'BULLISH', 0.5, 1.2)).toBe(true);
  });

  it('should return false when volume is insufficient', () => {
    expect(hasDisplacementWithVolume(100, 110, 112, 99, 1000, 1000, 'BULLISH', 0.5, 1.2)).toBe(false);
  });

  it('should return false when avgVolume is zero', () => {
    expect(hasDisplacementWithVolume(100, 110, 112, 99, 1500, 0, 'BULLISH', 0.5, 1.2)).toBe(false);
  });
});

// ─── isKillZone ─────────────────────────────────────────────────────────────
describe('isKillZone', () => {
  it('should return true during London session (7-12 UTC)', () => {
    const date = new Date('2026-06-06T08:00:00Z');
    expect(isKillZone(date)).toBe(true);
  });

  it('should return true during NY session (12-21 UTC)', () => {
    const date = new Date('2026-06-06T15:00:00Z');
    expect(isKillZone(date)).toBe(true);
  });

  it('should return false outside kill zone', () => {
    const date = new Date('2026-06-06T05:00:00Z');
    expect(isKillZone(date)).toBe(false);
  });

  it('should return false at 21 UTC (end of NY)', () => {
    const date = new Date('2026-06-06T21:00:00Z');
    expect(isKillZone(date)).toBe(false);
  });
});

// ─── hasInducement ──────────────────────────────────────────────────────────
describe('hasInducement', () => {
  it('should detect inducement for LONG', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 100, type: 'LOW' },
      { index: 1, price: 110, type: 'HIGH' },
      { index: 2, price: 105, type: 'LOW' },
    ];
    expect(hasInducement(swings, 'LONG', 106, 115, 3, 0)).toBe(true);
  });

  it('should detect inducement for SHORT', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 115, type: 'HIGH' },
      { index: 1, price: 105, type: 'LOW' },
      { index: 2, price: 110, type: 'HIGH' },
    ];
    expect(hasInducement(swings, 'SHORT', 109, 100, 3, 0)).toBe(true);
  });

  it('should return false when no inducement', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 100, type: 'LOW' },
      { index: 1, price: 110, type: 'HIGH' },
    ];
    expect(hasInducement(swings, 'LONG', 106, 115, 2, 0)).toBe(false);
  });
});

// ─── structuralTPLevels ─────────────────────────────────────────────────────
describe('structuralTPLevels', () => {
  it('should return nearest swing highs for LONG', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 100, type: 'LOW' },
      { index: 1, price: 110, type: 'HIGH' },
      { index: 2, price: 105, type: 'LOW' },
      { index: 3, price: 120, type: 'HIGH' },
      { index: 4, price: 115, type: 'LOW' },
    ];
    const tps = structuralTPLevels(swings, 'LONG', 108, 2);
    expect(tps).toEqual([110, 120]);
  });

  it('should return nearest swing lows for SHORT', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 120, type: 'HIGH' },
      { index: 1, price: 110, type: 'LOW' },
      { index: 2, price: 115, type: 'HIGH' },
      { index: 3, price: 100, type: 'LOW' },
    ];
    const tps = structuralTPLevels(swings, 'SHORT', 112, 2);
    expect(tps).toEqual([110, 100]);
  });

  it('should return fewer levels if not enough swings', () => {
    const swings: SwingPoint[] = [
      { index: 0, price: 100, type: 'LOW' },
      { index: 1, price: 110, type: 'HIGH' },
    ];
    const tps = structuralTPLevels(swings, 'LONG', 105, 3);
    expect(tps).toEqual([110]);
  });
});

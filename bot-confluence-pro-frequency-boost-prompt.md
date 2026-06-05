# Brief: Frequency Boost untuk bot-confluence-pro

## Context

Project: bot-confluence-pro (TypeScript SMC trading bot di Bitget).

**Prerequisite**: Priority 1-8 dari `bot-confluence-pro-fix-prompt.md` HARUS sudah selesai dan terbackest. Kalau belum, STOP — kerjain itu dulu.

Setelah priority 1-8, frequency trade diharapkan turun (filter lebih ketat = lebih selektif). User butuh minimum 1 trade/hari untuk ROI yang masuk akal. Prompt ini nge-boost frequency **tanpa nge-disable filter quality** yang udah dibangun.

## Working Protocol

Sama kayak prompt sebelumnya — kerjain BOOSTER 1, backtest, report, tunggu konfirmasi. Lanjut ke BOOSTER 2 cuma kalau frequency masih kurang.

**Hard rule**: Kalau setelah suatu booster udah 1-2 trade/hari, **STOP**. Jangan apply booster berikutnya. More frequency past that point = diminishing returns + risk overtrade.

---

## BOOSTER 1: Expand Watchlist (Apply Pertama)

**Hypothesis**: 16 coin terlalu sempit. Banyak setup A+ yang ketiduran karena coin-nya ga di watchlist.

### 1a. Edit `src/index.ts`

```typescript
// Line 27 dan line 84
const topCoins = await Screener.getTopTrendingCoins(40);  // was 16
// ...di setInterval re-screen juga:
const newCoins = await Screener.getTopTrendingCoins(40);  // was 16
```

### 1b. Sanity check di `src/screener.ts`

Pastikan filter likuiditas & range volatility (yang udah di-apply di Priority 6) tetep ketat. Kalau pool yang lolos filter < 40, just return whatever lolos — JANGAN turunin threshold likuiditas buat fill 40 slot.

### 1c. WebSocket capacity check

Bitget WS limit per connection: ~240 channels. Dengan 40 coin × 3 TF (5m, 1H, 4H), itu 120 subscriptions — masih aman. Kalau nanti tambah 15m (booster 2), jadi 160 subscriptions — masih aman.

**Verification**:
- Run backtest dengan watchlist 40 coin (modify backtest.ts kalau perlu — tapi backtest biasanya single symbol, jadi ga relevan)
- Run live (DRY_RUN=true) selama 24 jam, count signals yang fire
- Report: berapa setup/hari rata-rata sekarang vs sebelum

**STOP point**: Kalau hasil > 1 trade/hari, STOP — jangan apply booster 2/3.

---

## BOOSTER 2: 15m Parallel Entry Timeframe

**Hypothesis**: 5m terlalu noisy, banyak setup yang ke-filter karena 5m structure ga clean. 15m setup lebih reliable dan fire di window waktu yang beda dari 5m.

Implementation: dual entry — bot scan 5m setup DAN 15m setup. Setup yang qualify (mana aja yang fire duluan) jadi trade.

### 2a. Update `MarketData` di `src/smc.ts`

```typescript
export interface MarketData {
    opens5m: number[]; highs5m: number[]; lows5m: number[]; closes5m: number[]; volumes5m: number[]; lastTs5m: string;
    opens15m: number[]; highs15m: number[]; lows15m: number[]; closes15m: number[]; volumes15m: number[]; lastTs15m: string;
    opens1h: number[]; highs1h: number[]; lows1h: number[]; closes1h: number[]; volumes1h: number[]; lastTs1h: string;
    opens4h: number[]; highs4h: number[]; lows4h: number[]; closes4h: number[]; volumes4h: number[]; lastTs4h: string;
}
```

### 2b. Update `src/screener.ts` `injectMemory()`

Tambahin parallel fetch untuk 15m candles (granularity=`15m`, limit=100). Extract opens/highs/lows/closes/volumes/lastTs untuk 15m. Update error fallback.

### 2c. Update `src/websocket.ts`

- Update `buildSubscribeArgs` untuk subscribe `candle15m` juga
- Update message handler — kalau channel = candle15m, dataKey = '15m'
- Trigger evaluation pas 15m close (mirror logic 5m, tapi pakai metode beda)

```typescript
if (m[`lastTs${dataKey}`] !== ts) {
    if (m[`lastTs${dataKey}`] !== '' && dataKey === '5m') {
        const signal = ScoringEngine.evaluateSMCMTF(symbol, m, '5m');
        if (signal) await ExecutionEngine.openPositionSMC(signal);
    }
    if (m[`lastTs${dataKey}`] !== '' && dataKey === '15m') {
        const signal = ScoringEngine.evaluateSMCMTF(symbol, m, '15m');
        if (signal) await ExecutionEngine.openPositionSMC(signal);
    }
    // ...push candle data
}
```

### 2d. Refactor `src/scoring.ts` untuk dukung parameterized LTF

Ubah `evaluateSMCMTF` signature:

```typescript
public static evaluateSMCMTF(
    symbol: string, 
    data: MarketData, 
    ltfTimeframe: '5m' | '15m' = '5m'
): SMCSignal | null {
    // Pilih array LTF berdasarkan parameter
    const ltfOpens = ltfTimeframe === '5m' ? data.opens5m : data.opens15m;
    const ltfHighs = ltfTimeframe === '5m' ? data.highs5m : data.highs15m;
    const ltfLows = ltfTimeframe === '5m' ? data.lows5m : data.lows15m;
    const ltfCloses = ltfTimeframe === '5m' ? data.closes5m : data.closes15m;
    const ltfVolumes = ltfTimeframe === '5m' ? data.volumes5m : data.volumes15m;
    
    if (data.closes1h.length < 20 || ltfCloses.length < 20) return null;
    
    const currentPrice = ltfCloses[ltfCloses.length - 1];
    
    // ... rest of logic pakai ltfOpens/Highs/Lows/Closes/Volumes
    // Bias 1H & 4H tetep sama (HTF bias ga berubah)
    // TP tetep dari 1H structure
}
```

Pass parameter ke `evaluateSide` juga, dan gunakan LTF arrays di gates yang sebelumnya pakai `data.highs5m` dll.

### 2e. Update `src/backtest.ts`

Tambahin fetch 15m candles. Build `MarketData` per bar 15m juga. Run backtest 2 mode:
- Mode A: cuma 5m signals
- Mode B: cuma 15m signals
- Mode C: kombinasi (yang ini buat live)

Report separately untuk masing-masing — jadi tau 15m vs 5m mana yang lebih profitable.

### 2f. Position sizing differentiation (optional tapi recommended)

15m setup lebih reliable, kasih size lebih besar:

```typescript
// Di execution.ts openPositionSMC, atau passing dari signal
const ltfTfMultiplier = signal.ltfTimeframe === '15m' ? 1.5 : 1.0;
const adjustedMargin = MARGIN * ltfTfMultiplier;
```

Tambahin `ltfTimeframe` ke `SMCSignal` interface.

**Verification**:
- Backtest kedua mode, compare metrics
- Live test (DRY_RUN) 24 jam, count signals dari 5m vs 15m
- Report: total trades/hari, breakdown 5m vs 15m, win rate masing-masing

**STOP point**: Kalau hasil > 1.5 trade/hari, STOP — jangan apply booster 3.

---

## BOOSTER 3: Tiered Confluence dengan Adaptive Position Sizing

**Hypothesis**: Beberapa confluence (sweep, OB, inducement) itu nice-to-have, bukan must-have. Bot binary all-or-nothing kelewat banyak setup yang 80% qualified. Solusi: score-based confluence dengan size yang scale sesuai quality.

⚠️ **WARNING**: Ini perubahan struktural yang complex. **Cuma apply kalau Booster 1 + 2 belum cukup.** Skip kalau frequency udah OK.

### 3a. Restructure scoring di `src/scoring.ts`

Buat enum tier & interface baru di atas SMC_CONFIG:

```typescript
export type Tier = 'A' | 'B' | 'C';

export interface TierConfig {
    threshold: number;       // minimum confluence points
    sizeMultiplier: number;  // applied to MARGIN_PER_TRADE
}

export const TIER_CONFIG: Record<Tier, TierConfig> = {
    A: { threshold: 12, sizeMultiplier: 1.0 },   // premium
    B: { threshold: 9,  sizeMultiplier: 0.5 },   // good
    C: { threshold: 7,  sizeMultiplier: 0.25 },  // acceptable
};
```

Tambahin `tier` dan `sizeMultiplier` ke `SMCSignal`:

```typescript
export interface SMCSignal {
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    slPrice: number;
    tpLevels: number[];
    tpPrice: number;
    confluence: string[];
    score: number;            // NEW
    tier: Tier;               // NEW
    sizeMultiplier: number;   // NEW
    ltfTimeframe?: '5m' | '15m';  // NEW (kalau booster 2 udah applied)
}
```

### 3b. Refactor `evaluateSide` jadi score-based

Replace gate-based dengan score-accumulation. Struktur:

**Hard gates (must pass — kalau gagal, return null):**
1. 4H bias not NEUTRAL
2. 1H bias not NEUTRAL & align dengan 4H
3. HTF FVG ada & contain currentPrice & unmitigated
4. LTF FVG ada & contain currentPrice & unmitigated & mature (>= minFvgAge)
5. Basic displacement (body ratio ≥ 0.5 di FVG candle)
6. RR ke nearTP ≥ minRR (turunin minRR ke 1.5 untuk Tier C)

**Soft confluences (score-affecting):**

```typescript
let score = 0;
const components: { name: string; points: number }[] = [];

// Bias strength
score += 2; components.push({ name: 'BIAS_4H', points: 2 });
score += 2; components.push({ name: 'BIAS_1H', points: 2 });

// FVG presence
score += 2; components.push({ name: 'HTF_FVG', points: 2 });
score += 2; components.push({ name: 'LTF_FVG', points: 2 });

// Soft confluences (each adds score)
const swept = detectLiquiditySweep(/*...*/);
if (swept) { score += 3; components.push({ name: 'LIQ_SWEEP', points: 3 }); }

const ob = findOrderBlock(/*...*/);
const obConfluent = ob && zonesOverlap(ob, ltfFvg);
if (obConfluent) { score += 2; components.push({ name: 'OB', points: 2 }); }

const noInducement = !hasInducement(/*...*/);
if (noInducement) { score += 2; components.push({ name: 'NO_INDUCEMENT', points: 2 }); }

// Volume-confirmed displacement (in addition to basic displacement)
const dispVol = hasDisplacementWithVolume(/*...*/);
if (dispVol) { score += 2; components.push({ name: 'DISP_VOL', points: 2 }); }

// FVG maturity bonus (older FVG = more reliable)
const fvgAge = currentIdx - ltfFvg.index;
if (fvgAge >= 5) { score += 1; components.push({ name: 'MATURE_FVG', points: 1 }); }

// Session bonus
if (isKillZone()) { score += 1; components.push({ name: 'KILLZONE', points: 1 }); }
```

**Tier determination:**

```typescript
let tier: Tier;
if (score >= TIER_CONFIG.A.threshold) tier = 'A';
else if (score >= TIER_CONFIG.B.threshold) tier = 'B';
else if (score >= TIER_CONFIG.C.threshold) tier = 'C';
else return null;

const sizeMultiplier = TIER_CONFIG[tier].sizeMultiplier;
```

**Tier-specific minRR (optional, lebih konservatif untuk Tier C):**

```typescript
const tierMinRR: Record<Tier, number> = { A: 2.0, B: 2.0, C: 2.5 };
if (rr < tierMinRR[tier]) return null;
```

Return signal dengan score, tier, sizeMultiplier.

### 3c. Update `src/execution.ts` `openPositionSMC`

Apply sizeMultiplier ke margin:

```typescript
const sizeMultiplier = signal.sizeMultiplier ?? 1.0;
const adjustedMargin = MARGIN * sizeMultiplier;
const rawQty = (adjustedMargin * LEVERAGE) / entryPrice;
```

Update logging untuk show tier:

```typescript
console.log(`\n🚀 [SMC EXEC ${signal.tier}-TIER (${(sizeMultiplier*100).toFixed(0)}%)] ${side} ${symbol} qty=${totalQtyStr} @ ${entryPrice}`);
console.log(`   Score: ${signal.score} | ${confluence.join(' + ')}`);
console.log(`   SL: ${slStr} | TPs: ${tpStrs.join('/')}`);
```

### 3d. Update dashboard (opsional)

Di `views/dashboard.ejs`, kalau ada display untuk active position, show tier-nya. Skip kalau ga prioritas.

### 3e. Update `src/backtest.ts`

Track per-tier statistics:

```typescript
const tierStats = { A: {trades: 0, wins: 0, pnl: 0}, B: {...}, C: {...} };
// Tally per closed trade
```

Report breakdown — biar tau Tier C apakah worth trading (jangan-jangan Tier C loss net).

**Verification**:
- Backtest dengan tier breakdown — report metrics per tier
- Validate: Tier A win rate ≥ Tier B win rate ≥ Tier C win rate (kalau ga, scoring system salah)
- Validate: Tier C harus tetep ada edge (>1.0 profit factor minimum)
- Kalau Tier C net loss di backtest, raise threshold C atau hapus Tier C

**Tuning guidelines kalau hasilnya off**:
- Trade frequency terlalu tinggi (>5/day): raise tier thresholds A→14, B→11, C→9
- Trade frequency masih kurang: lower thresholds A→11, B→8, C→6
- Tier C losing: hapus Tier C entirely
- Tier A & B sama bagus: merge jadi 1 tier, simpler

---

## BOOSTER 4 (Optional, Last Resort): Loosen FVG Age & Sweep Lookback

Cuma apply ini kalau Booster 1+2+3 udah selesai dan frequency MASIH < 1/day. Indikasi market kondisi lagi sepi setup dan filter terlalu ketat untuk regime sekarang.

### 4a. Loosen FVG age

Di `src/scoring.ts`:
```typescript
minFvgAge: 1,  // was 2 — allow younger FVG
```

### 4b. Expand sweep lookback

```typescript
sweepLookbackBars: 40,  // was 25 — scan further back for liquidity
sweepWindow: 8,         // was 5 — wider recent window for sweep detection
```

### 4c. Lower minRR

```typescript
minRR: 1.5,  // was 2 — was 5 — accept thinner RR
```

⚠️ Ini compromise terakhir. Setelah ini, kalau masih kurang, kondisi pasarnya yang ga mendukung — accept it. Don't compromise more.

---

## Decision Tree Summary

```
Setelah Priority 1-8 (main fix):
│
├─ Frequency ≥ 1.5/day? → STOP, semua OK
│
└─ Frequency < 1.5/day:
   │
   ├─ Apply Booster 1 (expand watchlist) → backtest → frequency check
   │  │
   │  ├─ ≥ 1.5/day? → STOP
   │  └─ < 1.5/day → continue
   │
   ├─ Apply Booster 2 (15m parallel) → backtest → frequency check
   │  │
   │  ├─ ≥ 1.5/day? → STOP
   │  └─ < 1.5/day → continue
   │
   ├─ Apply Booster 3 (tiered scoring) → backtest → frequency check
   │  │
   │  ├─ ≥ 1.5/day? → STOP
   │  └─ < 1.5/day → continue
   │
   └─ Apply Booster 4 (loosen filters) → final state
```

## Anti-pattern Checklist

JANGAN lakukan ini buat ngejar frequency:

- ❌ Disable `requireStructureBias` (bias check itu wajib)
- ❌ Disable `requireLiquiditySweep` di Tier A/B (ini diferensiator quality)
- ❌ Set `minRR` < 1.5
- ❌ Trade tanpa HTF alignment (4H bias contradicts 1H bias)
- ❌ Add coin tanpa likuiditas filter (volume > 10M USDT 24h)
- ❌ Reduce `slBufferPct` di bawah 0.001 (SL terlalu tight = noise stop-outs)

## Important Reminders

- Setelah tiap booster, **report metrics** dan **tunggu konfirmasi** sebelum lanjut
- Backtest dulu sebelum live — jangan asumsi
- Kalau metrics turun setelah suatu booster, REVERT booster itu dan analisa kenapa
- Frequency target: **1-2 trade/hari** (sweet spot). Lebih dari 3/hari = overtrading territory

Mulai dari Booster 1.

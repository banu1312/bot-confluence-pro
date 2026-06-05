import * as fs from 'fs';
import * as path from 'path';

export interface ActivePosition {
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    qty: number;                  // current remaining qty (decreases as TPs hit)
    originalQty: number;          // qty at entry — used to detect partial fills
    slPrice: number;              // current SL level (moves to breakeven after TP1)
    originalSL: number;           // SL at entry (unchanged after BE move) — needed for R calc
    tpLevels: number[];           // [TP1, TP2, ...] sorted nearest → farthest
    tpHit: boolean[];             // parallel array — true if that TP has filled
    slPlanId: string | null;      // Bitget plan order id for current SL
    tpPlanIds: (string | null)[]; // Bitget plan order ids for each TP
    breakevenMoved: boolean;      // true after SL has been moved to entry price
}

export interface DailyLossTracker {
    date: string;                 // 'YYYY-MM-DD' UTC
    realizedR: Record<string, number>; // symbol → cumulative R for the day (negative or positive)
}

const STATE_FILE = path.join(__dirname, '..', 'state.json');
const LOSS_FILE = path.join(__dirname, '..', 'daily-loss.json');

function utcDateStr(d: Date = new Date()): string {
    return d.toISOString().slice(0, 10);
}

// Conservative realized-R: assumes any unhit TP's portion exited via current SL
// (which is original SL if no BE move, or 0R if BE moved). This may under-count
// wins (if TP2 actually filled between reconcile cycles) but never over-counts losses,
// which is the right bias for safety-side decisions like halting.
export function calcRealizedR(pos: ActivePosition): number {
    const dir = pos.side === 'LONG' ? 1 : -1;
    const rDistance = Math.abs(pos.entryPrice - pos.originalSL);
    if (rDistance === 0) return 0;
    const portion = 1 / pos.tpLevels.length;

    let totalR = 0;
    let remaining = 1.0;
    for (let i = 0; i < pos.tpLevels.length; i++) {
        if (pos.tpHit[i]) {
            const tpR = ((pos.tpLevels[i] - pos.entryPrice) / rDistance) * dir;
            totalR += portion * tpR;
            remaining -= portion;
        }
    }
    if (remaining > 0.001) {
        const slR = pos.breakevenMoved ? 0 : -1;
        totalR += remaining * slR;
    }
    return totalR;
}

export interface AccountSnapshot {
    equity: number;
    available: number;
    locked: number;
    unrealizedPL: number;
    fetchedAt: number;        // ms epoch
}

export class StateManager {
    public static positions: ActivePosition[] = [];
    public static dailyLoss: DailyLossTracker = { date: utcDateStr(), realizedR: {} };
    public static account: AccountSnapshot | null = null;

    public static updateAccount(info: { equity: number; available: number; locked: number; unrealizedPL: number }) {
        this.account = { ...info, fetchedAt: Date.now() };
    }

    public static load() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                const raw = fs.readFileSync(STATE_FILE, 'utf-8');
                this.positions = JSON.parse(raw);
                console.log(`💾 [MEMORY] Loaded ${this.positions.length} position(s) from disk`);
            }
            if (fs.existsSync(LOSS_FILE)) {
                const raw = fs.readFileSync(LOSS_FILE, 'utf-8');
                const loaded: DailyLossTracker = JSON.parse(raw);
                // If saved date is stale, start fresh
                if (loaded.date === utcDateStr()) {
                    this.dailyLoss = loaded;
                    const halted = Object.entries(loaded.realizedR)
                        .filter(([, r]) => r < 0)
                        .map(([sym, r]) => `${sym}:${r.toFixed(2)}R`);
                    if (halted.length > 0) console.log(`💰 [LOSS] Today's running totals: ${halted.join(', ')}`);
                }
            }
        } catch (error: any) {
            console.error('❌ [MEMORY] Load failed:', error.message);
            this.positions = [];
        }
    }

    public static persist() {
        try {
            fs.writeFileSync(STATE_FILE, JSON.stringify(this.positions, null, 2));
        } catch (error: any) {
            console.error('❌ [MEMORY] Persist failed:', error.message);
        }
    }

    private static persistLoss() {
        try {
            fs.writeFileSync(LOSS_FILE, JSON.stringify(this.dailyLoss, null, 2));
        } catch (error: any) {
            console.error('❌ [LOSS] Persist failed:', error.message);
        }
    }

    private static rolloverIfNeeded() {
        const today = utcDateStr();
        if (this.dailyLoss.date !== today) {
            console.log(`📅 [LOSS] New UTC day — resetting per-coin loss counters`);
            this.dailyLoss = { date: today, realizedR: {} };
            this.persistLoss();
        }
    }

    public static recordPositionClosed(pos: ActivePosition): number {
        this.rolloverIfNeeded();
        const r = calcRealizedR(pos);
        const prev = this.dailyLoss.realizedR[pos.symbol] ?? 0;
        const newTotal = prev + r;
        this.dailyLoss.realizedR[pos.symbol] = newTotal;
        this.persistLoss();
        const sign = r >= 0 ? '+' : '';
        const totalSign = newTotal >= 0 ? '+' : '';
        console.log(`📊 [CLOSE] ${pos.symbol}: ${sign}${r.toFixed(2)}R | today total: ${totalSign}${newTotal.toFixed(2)}R`);
        return r;
    }

    public static isHalted(symbol: string, maxLossR: number): boolean {
        this.rolloverIfNeeded();
        const current = this.dailyLoss.realizedR[symbol] ?? 0;
        return current <= -maxLossR;
    }

    public static addPosition(pos: ActivePosition) {
        this.positions.push(pos);
        this.persist();
        console.log(`💾 [MEMORY] Posisi ${pos.symbol} tersimpan di RAM + disk.`);
    }

    public static removePosition(symbol: string) {
        this.positions = this.positions.filter(p => p.symbol !== symbol);
        this.persist();
        console.log(`🗑️  [MEMORY] Posisi ${symbol} dihapus dari RAM + disk.`);
    }

    public static find(symbol: string): ActivePosition | undefined {
        return this.positions.find(p => p.symbol === symbol);
    }

    public static updateAfterTp1(symbol: string, newSlPrice: number, newSlPlanId: string | null, newQty: number) {
        const p = this.find(symbol);
        if (!p) return;
        p.tpHit[0] = true;
        p.breakevenMoved = true;
        p.slPrice = newSlPrice;
        p.slPlanId = newSlPlanId;
        p.qty = newQty;
        this.persist();
    }

    public static reconcile(openSymbols: Set<string>) {
        const closed = this.positions.filter(p => !openSymbols.has(p.symbol));
        if (closed.length === 0) return;
        this.positions = this.positions.filter(p => openSymbols.has(p.symbol));
        this.persist();
        console.log(`🔄 [RECONCILE] Closed externally: ${closed.map(p => p.symbol).join(', ')}`);
    }
}

import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { StateManager, ActivePosition } from './state';
import { SMCSignal } from './scoring';
import { calculateATR } from './smc';
dotenv.config();

const API_KEY = process.env.EXCHANGE_API_KEY || '';
const API_SECRET = process.env.EXCHANGE_API_SECRET || '';
const API_PASSPHRASE = process.env.EXCHANGE_API_PASSPHRASE || '';
const MARGIN = parseFloat(process.env.MARGIN_PER_TRADE || '10');
const LEVERAGE = parseInt(process.env.LEVERAGE || '20', 10);
const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_DAILY_LOSS_R = parseFloat(process.env.MAX_DAILY_LOSS_R || '3');

// Dynamic position sizing parameters
const RISK_PER_TRADE_PCT = parseFloat(process.env.RISK_PER_TRADE_PCT || '1');
const ATR_PERIOD = parseInt(process.env.ATR_PERIOD || '14', 10);
const ATR_MULTIPLIER_SL = parseFloat(process.env.ATR_MULTIPLIER_SL || '2');

// Trailing stop parameters
const TRAIL_PCT = parseFloat(process.env.TRAIL_PCT || '0.005'); // 0.5% default

// Retry parameters
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // 1 second between retries

const BASE_URL = 'https://api.bitget.com';

interface ContractSpec {
    pricePlace: number;
    priceEndStep: number;
    volumePlace: number;
    sizeMultiplier: number;
    minTradeNum: number;
    minTradeUSDT: number;
}

export class ExecutionEngine {
    private static executingSymbols: Set<string> = new Set();
    private static specs: Map<string, ContractSpec> = new Map();
    private static configuredSymbols: Set<string> = new Set();

    private static createSignature(timestamp: string, method: string, requestPath: string, body: string) {
        const message = timestamp + method + requestPath + body;
        return crypto.createHmac('sha256', API_SECRET).update(message).digest('base64');
    }

    private static async sendRequest(method: 'POST' | 'GET', endpoint: string, payload: any = {}) {
        const url = `${BASE_URL}${endpoint}`;
        const isGet = method === 'GET';
        const bodyStr = isGet ? '' : JSON.stringify(payload);
        const timestamp = Date.now().toString();
        const sign = this.createSignature(timestamp, method, endpoint, bodyStr);
        try {
            const config: any = {
                method, url, headers: {
                    'ACCESS-KEY': API_KEY, 'ACCESS-SIGN': sign, 'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': API_PASSPHRASE, 'Content-Type': 'application/json'
                }
            };
            if (!isGet) config.data = bodyStr;
            const response = await axios(config);
            return response.data;
        } catch (error: any) {
            const status = error.response?.status;
            const isServerError = !status || status >= 500;
            const isClientError = status && status >= 400 && status < 500;
            if (isClientError) {
                console.error(`❌ API Client Error (${endpoint}):`, error.response?.data || error.message);
                // Return a special object so sendRequestWithRetry knows not to retry
                return { _clientError: true, code: status, message: error.response?.data?.msg || error.message };
            }
            console.error(`❌ API Error (${endpoint}):`, error.response?.data || error.message);
            return null;
        }
    }

    // ─── Retry wrapper for sendRequest ──────────────────────────────────────
    // Retries up to MAX_RETRIES times with RETRY_DELAY_MS delay between attempts.
    // Only retries on network errors (no response) or 5xx server errors.
    // Does NOT retry on 4xx client errors (invalid params, insufficient balance, etc.).
    private static async sendRequestWithRetry(
        method: 'POST' | 'GET',
        endpoint: string,
        payload: any = {},
        label: string = ''
    ): Promise<any> {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const result = await this.sendRequest(method, endpoint, payload);
            
            // If result is null (network error or 5xx), retry
            if (result === null) {
                if (attempt < MAX_RETRIES) {
                    console.warn(`🔄 [RETRY] ${label || endpoint} attempt ${attempt}/${MAX_RETRIES} failed — retrying in ${RETRY_DELAY_MS}ms`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                } else {
                    console.error(`❌ [RETRY] ${label || endpoint} failed after ${MAX_RETRIES} attempts`);
                }
                continue;
            }
            
            // If result is a client error (4xx), do NOT retry
            if (result._clientError) {
                console.error(`❌ [RETRY] ${label || endpoint} client error (${result.code}) — not retrying`);
                return null;
            }
            
            // Success
            return result;
        }
        return null;
    }

    public static getPricePlace(symbol: string): number {
        return this.specs.get(symbol)?.pricePlace ?? 4;
    }

    public static async loadContractSpecs(): Promise<void> {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const res = await axios.get(`${BASE_URL}/api/v2/mix/market/contracts?productType=USDT-FUTURES`);
                const contracts = res.data?.data ?? [];
                for (const c of contracts) {
                    this.specs.set(c.symbol, {
                        pricePlace: parseInt(c.pricePlace, 10),
                        priceEndStep: parseInt(c.priceEndStep, 10) || 1,
                        volumePlace: parseInt(c.volumePlace, 10),
                        sizeMultiplier: parseFloat(c.sizeMultiplier),
                        minTradeNum: parseFloat(c.minTradeNum),
                        minTradeUSDT: parseFloat(c.minTradeUSDT || '0')
                    });
                }
                console.log(`📐 [SPECS] Loaded contract specs for ${this.specs.size} symbols`);
                return;
            } catch (error: any) {
                const isServerError = error.response?.status >= 500 || !error.response;
                if (attempt < MAX_RETRIES && isServerError) {
                    console.warn(`🔄 [RETRY] loadContractSpecs attempt ${attempt}/${MAX_RETRIES} failed — retrying in ${RETRY_DELAY_MS}ms`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                } else {
                    console.error(`❌ [SPECS] Failed to load contract specs after ${attempt} attempts:`, error.message);
                    return;
                }
            }
        }
    }

    private static formatPrice(price: number, spec: ContractSpec): string {
        const increment = spec.priceEndStep / Math.pow(10, spec.pricePlace);
        const snapped = Math.round(price / increment) * increment;
        return snapped.toFixed(spec.pricePlace);
    }

    private static formatQty(qty: number, spec: ContractSpec): string | null {
        const stepped = Math.floor(qty / spec.sizeMultiplier) * spec.sizeMultiplier;
        if (stepped < spec.minTradeNum) return null;
        return stepped.toFixed(spec.volumePlace);
    }

    // ─── Update trailing stop for positions that already have trail activated ──
    // Called periodically (every RECONCILE_MS) to move SL closer to current price.
    public static async updateTrailingStop(position: ActivePosition, remainingQty: number, currentPrice: number): Promise<void> {
        if (!position.trailActivated) return;
        const spec = this.specs.get(position.symbol);
        if (!spec) return;

        // Calculate new trailing SL level
        let newSlPrice: number;
        if (position.side === 'LONG') {
            newSlPrice = currentPrice * (1 - TRAIL_PCT);
            // Never move SL below entry (breakeven)
            if (newSlPrice < position.entryPrice) newSlPrice = position.entryPrice;
        } else {
            newSlPrice = currentPrice * (1 + TRAIL_PCT);
            if (newSlPrice > position.entryPrice) newSlPrice = position.entryPrice;
        }

        // Only update if new SL is better than current SL
        const isBetter = position.side === 'LONG'
            ? newSlPrice > position.slPrice
            : newSlPrice < position.slPrice;
        if (!isBetter) return;

        const newSlStr = this.formatPrice(newSlPrice, spec);
        const remainingQtyStr = this.formatQty(remainingQty, spec);
        if (remainingQtyStr === null) return;

        console.log(`🔄 [TRAIL] ${position.symbol}: updating SL from ${position.slPrice.toFixed(4)} to ${newSlStr} (trail ${TRAIL_PCT*100}% from ${currentPrice})`);

        if (DRY_RUN) return;

        if (position.slPlanId) {
            await this.cancelPlanOrder(position.symbol, 'loss_plan', position.slPlanId);
        }
        const newSlId = await this.placePlanOrder(
            position.symbol, position.side, 'loss_plan', newSlStr, remainingQtyStr
        );
        if (!newSlId) {
            console.error(`❌ [TRAIL] Failed to update trailing SL for ${position.symbol}`);
            return;
        }
        position.slPrice = newSlPrice;
        position.slPlanId = newSlId;
        StateManager.persist();
    }

    // ─── Dynamic position sizing based on ATR and equity ───────────────────
    // Calculates qty so that the dollar risk (entry - SL) equals
    // RISK_PER_TRADE_PCT % of current equity.
    private static calculateDynamicQty = (
        symbol: string,
        entryPrice: number,
        side: 'LONG' | 'SHORT',
        slPrice: number,
        equity: number
    ): number | null => {
        const spec = ExecutionEngine.specs.get(symbol);
        if (!spec) return null;

        const slDistance = Math.abs(entryPrice - slPrice);
        if (slDistance <= 0) return null;

        const riskAmount = equity * (RISK_PER_TRADE_PCT / 100);
        const rawQty = riskAmount / slDistance;

        const qtyStr = ExecutionEngine.formatQty(rawQty, spec);
        if (qtyStr === null) return null;

        return parseFloat(qtyStr);
    }

    private static async ensureSymbolConfig(symbol: string): Promise<boolean> {
        if (this.configuredSymbols.has(symbol)) return true;
        await this.sendRequestWithRetry('POST', '/api/v2/mix/account/set-margin-mode', {
            symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', marginMode: 'isolated'
        }, `setMarginMode(${symbol})`);
        const levRes = await this.sendRequestWithRetry('POST', '/api/v2/mix/account/set-leverage', {
            symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
            leverage: LEVERAGE.toString()
        }, `setLeverage(${symbol})`);
        if (levRes && levRes.code === '00000') {
            this.configuredSymbols.add(symbol);
            console.log(`⚙️  [CONFIG] ${symbol}: isolated, ${LEVERAGE}x`);
            return true;
        }
        console.error(`⚠️  [CONFIG] Failed to configure leverage for ${symbol}`);
        return false;
    }

    public static async fetchAccountInfo(): Promise<{ equity: number; available: number; locked: number; unrealizedPL: number } | null> {
        const res = await this.sendRequestWithRetry('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES', {}, 'fetchAccountInfo');
        if (!res || res.code !== '00000') return null;
        const accounts: any[] = res.data ?? [];
        const usdt = accounts.find(a => a.marginCoin === 'USDT');
        if (!usdt) return null;
        return {
            equity: parseFloat(usdt.usdtEquity ?? usdt.equity ?? '0'),
            available: parseFloat(usdt.available ?? '0'),
            locked: parseFloat(usdt.locked ?? '0'),
            unrealizedPL: parseFloat(usdt.unrealizedPL ?? '0')
        };
    }

    public static async fetchOpenPositions(): Promise<Map<string, number> | null> {
        const res = await this.sendRequestWithRetry('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT', {}, 'fetchOpenPositions');
        if (!res || res.code !== '00000') return null;
        const positions = res.data ?? [];
        const out = new Map<string, number>();
        for (const p of positions) {
            const total = parseFloat(p.total);
            if (total > 0) out.set(p.symbol, total);
        }
        return out;
    }

    private static async fetchFillPrice(symbol: string, orderId: string): Promise<number | null> {
        const res = await this.sendRequestWithRetry('GET', `/api/v2/mix/order/detail?symbol=${symbol}&productType=USDT-FUTURES&orderId=${orderId}`, {}, `fetchFillPrice(${symbol})`);
        if (!res || res.code !== '00000') return null;
        const avg = parseFloat(res.data?.priceAvg ?? '0');
        return avg > 0 ? avg : null;
    }

    private static async placePlanOrder(
        symbol: string,
        side: 'LONG' | 'SHORT',
        planType: 'profit_plan' | 'loss_plan',
        triggerPriceStr: string,
        sizeStr: string
    ): Promise<string | null> {
        const clientOid = `${planType}-${symbol}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const res = await this.sendRequestWithRetry('POST', '/api/v2/mix/order/place-tpsl-order', {
            marginCoin: 'USDT',
            productType: 'USDT-FUTURES',
            symbol,
            planType,
            triggerPrice: triggerPriceStr,
            triggerType: 'fill_price',
            executePrice: '0',
            size: sizeStr,
            clientOid
        }, `placePlanOrder(${symbol},${planType})`);
        if (res?.code === '00000') return res.data?.orderId ?? null;
        return null;
    }

    private static async cancelPlanOrder(symbol: string, planType: 'profit_plan' | 'loss_plan', orderId: string): Promise<boolean> {
        const res = await this.sendRequestWithRetry('POST', '/api/v2/mix/order/cancel-plan-order', {
            marginCoin: 'USDT',
            productType: 'USDT-FUTURES',
            symbol,
            planType,
            orderId
        }, `cancelPlanOrder(${symbol},${planType})`);
        return res?.code === '00000';
    }

    public static async cancelAllPlansFor(position: ActivePosition): Promise<void> {
        if (position.slPlanId) {
            await this.cancelPlanOrder(position.symbol, 'loss_plan', position.slPlanId);
        }
        for (const tpId of position.tpPlanIds) {
            if (tpId) await this.cancelPlanOrder(position.symbol, 'profit_plan', tpId);
        }
    }

    public static async moveSLToTrailing(position: ActivePosition, remainingQty: number, currentPrice: number): Promise<void> {
        const spec = this.specs.get(position.symbol);
        if (!spec) {
            console.warn(`⚠️  [TRAIL] No spec for ${position.symbol}, skipping trailing move`);
            return;
        }

        // Calculate trailing SL level
        let newSlPrice: number;
        if (position.side === 'LONG') {
            newSlPrice = currentPrice * (1 - TRAIL_PCT);
            // Ensure trailing SL is at least at entry (breakeven)
            if (newSlPrice < position.entryPrice) newSlPrice = position.entryPrice;
        } else {
            newSlPrice = currentPrice * (1 + TRAIL_PCT);
            if (newSlPrice > position.entryPrice) newSlPrice = position.entryPrice;
        }

        const newSlStr = this.formatPrice(newSlPrice, spec);
        const remainingQtyStr = this.formatQty(remainingQty, spec);
        if (remainingQtyStr === null) {
            console.warn(`⚠️  [TRAIL] Remaining qty ${remainingQty} below min, skipping trailing move`);
            return;
        }

        console.log(`🛡️  [TRAIL] ${position.symbol}: moving SL to ${newSlStr} (trail ${TRAIL_PCT*100}% from ${currentPrice}), qty=${remainingQtyStr}`);

        if (DRY_RUN) {
            console.log(`💡 [DRY-RUN] Trailing move skipped for ${position.symbol}.`);
            return;
        }

        if (position.slPlanId) {
            await this.cancelPlanOrder(position.symbol, 'loss_plan', position.slPlanId);
        }
        const newSlId = await this.placePlanOrder(
            position.symbol, position.side, 'loss_plan', newSlStr, remainingQtyStr
        );
        if (!newSlId) {
            console.error(`❌ [TRAIL] Failed to place trailing SL for ${position.symbol} — REMAINING POSITION UNPROTECTED`);
        }
        StateManager.updateAfterTp1(position.symbol, newSlPrice, newSlId, remainingQty);
    }

    public static async openPositionSMC(signal: SMCSignal) {
        const { symbol, side, entryPrice, slPrice, tpLevels } = signal;

        if (this.executingSymbols.has(symbol) || StateManager.find(symbol)) return;
        if (StateManager.positions.length >= 1) return;
        if (StateManager.isHalted(symbol, MAX_DAILY_LOSS_R)) {
            console.log(`🚫 [HALT] ${symbol}: daily loss limit (-${MAX_DAILY_LOSS_R}R) reached, skipping until UTC midnight`);
            return;
        }
        this.executingSymbols.add(symbol);

        try {
            const spec = this.specs.get(symbol);
            if (!spec) {
                console.warn(`⚠️  [EXEC] No contract spec for ${symbol} — skipping`);
                return;
            }

            // SL sanity (preserves 40834 protection)
            let sl = slPrice;
            if (side === 'LONG' && sl >= entryPrice) sl = entryPrice * 0.995;
            else if (side === 'SHORT' && sl <= entryPrice) sl = entryPrice * 1.005;

            const slStr = this.formatPrice(sl, spec);
            const tpStrs = tpLevels.map(tp => this.formatPrice(tp, spec));

            // Dynamic position sizing based on ATR and equity
            const acct = await this.fetchAccountInfo();
            if (!acct || acct.available < MARGIN) {
                console.warn(`⚠️  [EXEC] ${symbol}: insufficient margin (available: ${acct?.available.toFixed(2) ?? 0} USDT, needed: ${MARGIN} USDT)`);
                return;
            }

            // Calculate ATR for the relevant LTF (5m or 15m)
            const atr = calculateATR(
                signal.ltfTimeframe === '5m' ? (signal.data?.highs5m ?? []) : (signal.data?.highs15m ?? []),
                signal.ltfTimeframe === '5m' ? (signal.data?.lows5m ?? []) : (signal.data?.lows15m ?? []),
                signal.ltfTimeframe === '5m' ? (signal.data?.closes5m ?? []) : (signal.data?.closes15m ?? []),
                ATR_PERIOD
            );

            // Use dynamic qty based on risk % of equity
            const totalQtyNum = this.calculateDynamicQty(symbol, entryPrice, side, sl, acct.equity);
            if (totalQtyNum === null) {
                console.warn(`⚠️  [EXEC] ${symbol}: dynamic qty calculation failed`);
                return;
            }
            const totalQtyStr = this.formatQty(totalQtyNum, spec);
            if (totalQtyStr === null) {
                console.warn(`⚠️  [EXEC] ${symbol}: qty ${totalQtyNum.toFixed(8)} below minTradeNum`);
                return;
            }

            const notional = totalQtyNum * entryPrice;
            if (spec.minTradeUSDT > 0 && notional < spec.minTradeUSDT) {
                console.warn(`⚠️  [EXEC] ${symbol}: notional ${notional.toFixed(2)} below minTradeUSDT ${spec.minTradeUSDT}`);
                return;
            }

            // Split qty across TPs. Floor each piece, last TP absorbs remainder.
            const tpCount = tpLevels.length;
            const evenSlice = totalQtyNum / tpCount;
            const sliceStr = this.formatQty(evenSlice, spec);
            if (sliceStr === null) {
                console.warn(`⚠️  [EXEC] ${symbol}: qty ${totalQtyNum} too small to split across ${tpCount} TPs`);
                return;
            }
            const sliceNum = parseFloat(sliceStr);
            const tpQtys: string[] = [];
            for (let i = 0; i < tpCount - 1; i++) tpQtys.push(sliceStr);
            // Last TP gets the remainder — validated via formatQty for proper min-size check
            const lastQtyRaw = totalQtyNum - sliceNum * (tpCount - 1);
            const lastQtyStr = this.formatQty(lastQtyRaw, spec);
            if (lastQtyStr === null) {
                console.warn(`⚠️  [EXEC] ${symbol}: last TP slice ${lastQtyRaw.toFixed(8)} below minTradeNum`);
                return;
            }
            tpQtys.push(lastQtyStr);

            const configured = await this.ensureSymbolConfig(symbol);
            if (!configured) return;

            console.log(`\n🚀 [SMC EXECUTION${DRY_RUN ? ' (DRY-RUN)' : ''}] ${side} ${symbol} qty=${totalQtyStr} @ ${entryPrice}`);
            console.log(`   SL: ${slStr} | TPs: ${tpStrs.map((s, i) => `${s}(${tpQtys[i]})`).join(' / ')}`);

            if (DRY_RUN) {
                console.log(`💡 [DRY-RUN] Plan orders skipped, state NOT updated.`);
                return;
            }

            // 1. Main market order (with retry)
            const clientOid = `smc-${symbol}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
            const mainRes = await this.sendRequestWithRetry('POST', '/api/v2/mix/order/place-order', {
                symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', marginMode: 'isolated',
                side: side === 'LONG' ? 'buy' : 'sell',
                orderType: 'market',
                size: totalQtyStr,
                clientOid
            }, `placeOrder(${symbol})`);
            if (!mainRes || mainRes.code !== '00000') {
                console.error(`❌ [EXEC] Main order failed for ${symbol} after retries`);
                return;
            }

            // Fetch actual fill price for accurate R tracking
            const fillOrderId: string | undefined = mainRes.data?.orderId;
            const fillPrice = fillOrderId ? await this.fetchFillPrice(symbol, fillOrderId) : null;
            const actualEntry = fillPrice ?? entryPrice;
            if (fillPrice && Math.abs(fillPrice - entryPrice) / entryPrice > 0.005) {
                console.warn(`⚠️  [EXEC] ${symbol}: fill slippage ${((fillPrice / entryPrice - 1) * 100).toFixed(3)}%`);
            }

            // 2. SL plan (full qty)
            const slPlanId = await this.placePlanOrder(symbol, side, 'loss_plan', slStr, totalQtyStr);
            if (!slPlanId) {
                console.error(`🆘 [EXEC] ${symbol}: SL plan FAILED after position opened — position is UNPROTECTED`);
                // Continue to TPs anyway; user must manually intervene
            }

            // 3. TP plans (partial qty each)
            const tpPlanIds: (string | null)[] = [];
            for (let i = 0; i < tpCount; i++) {
                const id = await this.placePlanOrder(symbol, side, 'profit_plan', tpStrs[i], tpQtys[i]);
                if (!id) console.warn(`⚠️  [EXEC] ${symbol}: TP${i + 1} plan failed`);
                tpPlanIds.push(id);
            }

            const slPriceFinal = parseFloat(slStr);
            StateManager.addPosition({
                symbol, side,
                entryPrice: actualEntry,
                qty: totalQtyNum,
                originalQty: totalQtyNum,
                slPrice: slPriceFinal,
                originalSL: slPriceFinal,
                tpLevels: tpStrs.map(parseFloat),
                tpHit: new Array(tpCount).fill(false),
                slPlanId,
                tpPlanIds,
                breakevenMoved: false,
                trailActivated: false
            });
            StateManager.recordTradeMarker('entry', side, 0);
        } finally {
            this.executingSymbols.delete(symbol);
        }
    }
}

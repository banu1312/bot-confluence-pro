import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { StateManager, ActivePosition } from './state';
import { SMCSignal } from './scoring';
dotenv.config();

const API_KEY = process.env.EXCHANGE_API_KEY || '';
const API_SECRET = process.env.EXCHANGE_API_SECRET || '';
const API_PASSPHRASE = process.env.EXCHANGE_API_PASSPHRASE || '';
const MARGIN = parseFloat(process.env.MARGIN_PER_TRADE || '10');
const LEVERAGE = 20;
const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_DAILY_LOSS_R = parseFloat(process.env.MAX_DAILY_LOSS_R || '3');

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
            console.error(`❌ API Error (${endpoint}):`, error.response?.data || error.message);
            return null;
        }
    }

    public static getPricePlace(symbol: string): number {
        return this.specs.get(symbol)?.pricePlace ?? 4;
    }

    public static async loadContractSpecs(): Promise<void> {
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
        } catch (error: any) {
            console.error('❌ [SPECS] Failed to load contract specs:', error.message);
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

    private static async ensureSymbolConfig(symbol: string): Promise<boolean> {
        if (this.configuredSymbols.has(symbol)) return true;
        await this.sendRequest('POST', '/api/v2/mix/account/set-margin-mode', {
            symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', marginMode: 'isolated'
        });
        const levRes = await this.sendRequest('POST', '/api/v2/mix/account/set-leverage', {
            symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT',
            leverage: LEVERAGE.toString()
        });
        if (levRes && levRes.code === '00000') {
            this.configuredSymbols.add(symbol);
            console.log(`⚙️  [CONFIG] ${symbol}: isolated, ${LEVERAGE}x`);
            return true;
        }
        console.error(`⚠️  [CONFIG] Failed to configure leverage for ${symbol}`);
        return false;
    }

    public static async fetchAccountInfo(): Promise<{ equity: number; available: number; locked: number; unrealizedPL: number } | null> {
        const res = await this.sendRequest('GET', '/api/v2/mix/account/accounts?productType=USDT-FUTURES');
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
        const res = await this.sendRequest('GET', '/api/v2/mix/position/all-position?productType=USDT-FUTURES&marginCoin=USDT');
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
        const res = await this.sendRequest('GET', `/api/v2/mix/order/detail?symbol=${symbol}&productType=USDT-FUTURES&orderId=${orderId}`);
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
        const res = await this.sendRequest('POST', '/api/v2/mix/order/place-tpsl-order', {
            marginCoin: 'USDT',
            productType: 'USDT-FUTURES',
            symbol,
            planType,
            triggerPrice: triggerPriceStr,
            triggerType: 'fill_price',
            executePrice: '0',
            size: sizeStr,
            clientOid
        });
        if (res?.code === '00000') return res.data?.orderId ?? null;
        return null;
    }

    private static async cancelPlanOrder(symbol: string, planType: 'profit_plan' | 'loss_plan', orderId: string): Promise<boolean> {
        const res = await this.sendRequest('POST', '/api/v2/mix/order/cancel-plan-order', {
            marginCoin: 'USDT',
            productType: 'USDT-FUTURES',
            symbol,
            planType,
            orderId
        });
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

    public static async moveSLToBreakeven(position: ActivePosition, remainingQty: number): Promise<void> {
        const spec = this.specs.get(position.symbol);
        if (!spec) {
            console.warn(`⚠️  [BE] No spec for ${position.symbol}, skipping BE move`);
            return;
        }
        const newSlStr = this.formatPrice(position.entryPrice, spec);
        const remainingQtyStr = this.formatQty(remainingQty, spec);
        if (remainingQtyStr === null) {
            console.warn(`⚠️  [BE] Remaining qty ${remainingQty} below min, skipping BE move`);
            return;
        }

        console.log(`🛡️  [BE] ${position.symbol}: moving SL to entry ${newSlStr}, qty=${remainingQtyStr}`);

        if (DRY_RUN) {
            console.log(`💡 [DRY-RUN] BE move skipped for ${position.symbol}.`);
            return;
        }

        if (position.slPlanId) {
            await this.cancelPlanOrder(position.symbol, 'loss_plan', position.slPlanId);
        }
        const newSlId = await this.placePlanOrder(
            position.symbol, position.side, 'loss_plan', newSlStr, remainingQtyStr
        );
        if (!newSlId) {
            console.error(`❌ [BE] Failed to place breakeven SL for ${position.symbol} — REMAINING POSITION UNPROTECTED`);
        }
        StateManager.updateAfterTp1(position.symbol, position.entryPrice, newSlId, remainingQty);
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

            // Total qty
            const rawQty = (MARGIN * LEVERAGE) / entryPrice;
            const totalQtyStr = this.formatQty(rawQty, spec);
            if (totalQtyStr === null) {
                console.warn(`⚠️  [EXEC] ${symbol}: qty ${rawQty.toFixed(8)} below minTradeNum`);
                return;
            }
            const totalQtyNum = parseFloat(totalQtyStr);

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

            const acct = await this.fetchAccountInfo();
            if (!acct || acct.available < MARGIN) {
                console.warn(`⚠️  [EXEC] ${symbol}: insufficient margin (available: ${acct?.available.toFixed(2) ?? 0} USDT, needed: ${MARGIN} USDT)`);
                return;
            }

            const configured = await this.ensureSymbolConfig(symbol);
            if (!configured) return;

            console.log(`\n🚀 [SMC EXECUTION${DRY_RUN ? ' (DRY-RUN)' : ''}] ${side} ${symbol} qty=${totalQtyStr} @ ${entryPrice}`);
            console.log(`   SL: ${slStr} | TPs: ${tpStrs.map((s, i) => `${s}(${tpQtys[i]})`).join(' / ')}`);

            if (DRY_RUN) {
                console.log(`💡 [DRY-RUN] Plan orders skipped, state NOT updated.`);
                return;
            }

            // 1. Main market order
            const clientOid = `smc-${symbol}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
            const mainRes = await this.sendRequest('POST', '/api/v2/mix/order/place-order', {
                symbol, productType: 'USDT-FUTURES', marginCoin: 'USDT', marginMode: 'isolated',
                side: side === 'LONG' ? 'buy' : 'sell',
                orderType: 'market',
                size: totalQtyStr,
                clientOid
            });
            if (!mainRes || mainRes.code !== '00000') {
                console.error(`❌ [EXEC] Main order failed for ${symbol}`);
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
                breakevenMoved: false
            });
        } finally {
            this.executingSymbols.delete(symbol);
        }
    }
}

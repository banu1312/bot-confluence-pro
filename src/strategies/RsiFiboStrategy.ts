import { BaseStrategy } from './BaseStrategy';
import axios from 'axios';

const BASE_URL = 'https://api.bitget.com';
const LEVERAGE = 10;
const SL_PCT = 0.05;
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
const FIBO_LEVELS = [0.618, 0.786];
const MARKET_CAP_RANK_MIN = 50;
const MARKET_CAP_RANK_MAX = 200;
// Fix 1: Daily RSI trend filter
const DAILY_RSI_LONG_MIN = 40;
const DAILY_RSI_SHORT_MAX = 60;
// Fix 2: Max concurrent positions across all coins
const MAX_CONCURRENT = 3;

interface RsiFiboContext {
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    slPrice: number;
    fibo786: number;
    high4h: number;
    low4h: number;
    rsiAtTrigger: number;
    triggerTime: number;
    orderPlaced: boolean;
    orderId?: string;
    filled: boolean;
    fillPrice?: number;
    fillTime?: number;
    tpTriggered: boolean;
}

export class RsiFiboStrategy implements BaseStrategy {
    name = 'rsi_fibo';
    private activeContexts: Map<string, RsiFiboContext> = new Map();
    // Track active positions per symbol (max 1)
    private activePositions: Set<string> = new Set();

    async scanDailyWatchlist(): Promise<string[]> {
        try {
            const res = await axios.get(`${BASE_URL}/api/v2/mix/market/tickers?productType=USDT-FUTURES`);
            const tickers = res.data.data || [];
            
            const filtered = tickers
                .filter((t: any) => t.symbol.endsWith('USDT') && !t.symbol.startsWith('1000'))
                .sort((a: any, b: any) => parseFloat(b.quoteVolume || '0') - parseFloat(a.quoteVolume || '0'));
            
            const ranked = filtered.slice(0, MARKET_CAP_RANK_MAX);
            const watchlist = ranked.slice(MARKET_CAP_RANK_MIN - 1, MARKET_CAP_RANK_MAX);
            
            const withVolatility = await Promise.all(
                watchlist.slice(0, 30).map(async (t: any) => {
                    try {
                        const candles = await axios.get(
                            `${BASE_URL}/api/v2/mix/market/candles?symbol=${t.symbol}&granularity=4H&productType=USDT-FUTURES&limit=20`
                        );
                        const rows = candles.data.data || [];
                        if (rows.length < 14) return { symbol: t.symbol, atr: 0 };
                        
                        const closes = rows.map((r: string[]) => parseFloat(r[4]));
                        const highs = rows.map((r: string[]) => parseFloat(r[2]));
                        const lows = rows.map((r: string[]) => parseFloat(r[3]));
                        
                        let atr = 0;
                        for (let i = 1; i < rows.length; i++) {
                            const tr = Math.max(
                                highs[i] - lows[i],
                                Math.abs(highs[i] - closes[i - 1]),
                                Math.abs(lows[i] - closes[i - 1])
                            );
                            atr = i === 1 ? tr : (atr * 13 + tr) / 14;
                        }
                        return { symbol: t.symbol, atr };
                    } catch {
                        return { symbol: t.symbol, atr: 0 };
                    }
                })
            );
            
            const sorted = withVolatility.sort((a, b) => b.atr - a.atr);
            return sorted.slice(0, 10).map(s => s.symbol);
        } catch (error: any) {
            console.error(`❌ [RSI-FIBO] Scan error: ${error.message}`);
            return [];
        }
    }

    async checkHTFTrigger(symbol: string, candle4h: any): Promise<any> {
        if (this.activePositions.has(symbol)) return null;
        // Fix 2: max concurrent positions across all coins
        if (this.activePositions.size >= MAX_CONCURRENT) return null;

        try {
            const [res4h, res1d] = await Promise.all([
                axios.get(`${BASE_URL}/api/v2/mix/market/candles`, { params: { symbol, granularity: '4H', productType: 'USDT-FUTURES', limit: RSI_PERIOD + 5 } }),
                axios.get(`${BASE_URL}/api/v2/mix/market/candles`, { params: { symbol, granularity: '1D', productType: 'USDT-FUTURES', limit: RSI_PERIOD + 5 } })
            ]);

            const rows = res4h.data.data || [];
            if (rows.length < RSI_PERIOD + 1) return null;

            const closes = rows.map((r: string[]) => parseFloat(r[4]));
            const rsi = this.calculateRSI(closes, RSI_PERIOD);
            const currentRsi = rsi[rsi.length - 1];
            const currentCandle = rows[rows.length - 1];
            const currentClose = parseFloat(currentCandle[4]);
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);
            const currentOpen = parseFloat(currentCandle[1]);

            let trigger: any = null;

            if (currentRsi > RSI_OVERBOUGHT) {
                const upperWick = currentHigh - Math.max(currentClose, currentOpen);
                const lowerWick = Math.min(currentClose, currentOpen) - currentLow;
                if (upperWick > lowerWick) {
                    trigger = {
                        triggered: true,
                        side: 'SHORT',
                        high4h: currentHigh,
                        low4h: currentLow,
                        rsiAtTrigger: currentRsi,
                        triggerTime: parseInt(currentCandle[0], 10),
                        fibo786: currentHigh - (currentHigh - currentLow) * 0.786
                    };
                }
            } else if (currentRsi < RSI_OVERSOLD) {
                const upperWick = currentHigh - Math.max(currentClose, currentOpen);
                const lowerWick = Math.min(currentClose, currentOpen) - currentLow;
                if (lowerWick > upperWick) {
                    trigger = {
                        triggered: true,
                        side: 'LONG',
                        high4h: currentHigh,
                        low4h: currentLow,
                        rsiAtTrigger: currentRsi,
                        triggerTime: parseInt(currentCandle[0], 10),
                        fibo786: currentLow + (currentHigh - currentLow) * 0.786
                    };
                }
            }

            if (!trigger) return null;

            // Fix 1: Daily RSI trend filter
            const rows1d = res1d.data.data || [];
            if (rows1d.length >= RSI_PERIOD + 1) {
                const dailyCloses = rows1d.map((r: string[]) => parseFloat(r[4]));
                const dailyRsiArr = this.calculateRSI(dailyCloses, RSI_PERIOD);
                const dailyRsi = dailyRsiArr[dailyRsiArr.length - 1];
                if (trigger.side === 'LONG' && dailyRsi < DAILY_RSI_LONG_MIN) {
                    console.log(`🚫 [RSI-FIBO] ${symbol} LONG blocked: daily RSI ${dailyRsi.toFixed(1)} < ${DAILY_RSI_LONG_MIN}`);
                    return null;
                }
                if (trigger.side === 'SHORT' && dailyRsi > DAILY_RSI_SHORT_MAX) {
                    console.log(`🚫 [RSI-FIBO] ${symbol} SHORT blocked: daily RSI ${dailyRsi.toFixed(1)} > ${DAILY_RSI_SHORT_MAX}`);
                    return null;
                }
            }

            console.log(`📊 [RSI-FIBO] ${symbol} ${trigger.side} trigger: RSI=${trigger.rsiAtTrigger.toFixed(2)}, fibo786=${trigger.fibo786.toFixed(4)}`);
            return trigger;
        } catch (error: any) {
            console.error(`❌ [RSI-FIBO] HTF check error for ${symbol}: ${error.message}`);
            return null;
        }
    }

    async checkLTFEntry(symbol: string, triggerContext: any, candle15m: any): Promise<any> {
        // PROTEKSI OVERLAPPING: jika sudah ada posisi aktif, jangan buka baru
        if (this.activePositions.has(symbol)) {
            return null;
        }

        const existing = this.activeContexts.get(symbol);
        if (existing && existing.orderPlaced) {
            return this.monitorOrder(symbol, candle15m);
        }

        if (!triggerContext || !triggerContext.triggered) return null;

        const { side, fibo786, high4h, low4h, rsiAtTrigger, triggerTime } = triggerContext;

        const orderSide = side === 'SHORT' ? 'sell' : 'buy';
        const price = fibo786;
        const size = this.calculatePositionSize(symbol, price);

        try {
            const orderResult = await this.placeLimitOrder(symbol, orderSide, price, size);
            
            const context: RsiFiboContext = {
                symbol,
                side,
                entryPrice: price,
                slPrice: side === 'SHORT' ? price * (1 + SL_PCT) : price * (1 - SL_PCT),
                fibo786: price,
                high4h,
                low4h,
                rsiAtTrigger,
                triggerTime,
                orderPlaced: true,
                orderId: orderResult?.orderId,
                filled: false,
                tpTriggered: false
            };
            
            this.activeContexts.set(symbol, context);
            console.log(`📌 [RSI-FIBO] ${symbol} ${side} limit order placed @ ${price.toFixed(4)}`);
            
            return context;
        } catch (error: any) {
            console.error(`❌ [RSI-FIBO] Order placement error for ${symbol}: ${error.message}`);
            return null;
        }
    }

    async manageActivePosition(position: any, currentPrice: number, candle4h: any, candle15m: any): Promise<any> {
        const context = this.activeContexts.get(position.symbol);
        if (!context) return null;

        // Only handle filled positions
        if (!context.filled) return null;

        // 1. Hard SL (5%)
        const slHit = context.side === 'SHORT'
            ? currentPrice >= context.slPrice
            : currentPrice <= context.slPrice;
        
        if (slHit) {
            console.log(`🛑 [RSI-FIBO] ${position.symbol} hard SL hit @ ${currentPrice.toFixed(4)}`);
            this.activePositions.delete(position.symbol);
            this.activeContexts.delete(position.symbol);
            return { action: 'close', reason: 'HARD_SL' };
        }

        // 2. TP: RSI 4H reaches opposite extreme
        if (!context.tpTriggered) {
            const rsi4h = await this.getCurrentRSI(position.symbol);
            if (rsi4h !== null) {
                const tpCondition = context.side === 'SHORT' 
                    ? rsi4h < RSI_OVERSOLD 
                    : rsi4h > RSI_OVERBOUGHT;
                
                if (tpCondition) {
                    console.log(`🎯 [RSI-FIBO] ${position.symbol} TP triggered: RSI=${rsi4h.toFixed(2)}`);
                    context.tpTriggered = true;
                    this.activePositions.delete(position.symbol);
                    this.activeContexts.delete(position.symbol);
                    return { action: 'close', reason: 'TP_RSI' };
                }
            }
        }

        return null;
    }

    private async monitorOrder(symbol: string, candle15m: any): Promise<any> {
        const context = this.activeContexts.get(symbol);
        if (!context || context.filled) return null;

        const currentPrice = candle15m?.close || 0;
        if (currentPrice > 0) {
            const isFilled = context.side === 'SHORT'
                ? currentPrice <= context.entryPrice   // SHORT: tunggu harga turun ke entry pullback
                : currentPrice >= context.entryPrice;  // LONG: tunggu harga naik ke entry breakout
            
            if (isFilled) {
                context.filled = true;
                context.fillPrice = context.entryPrice;
                context.fillTime = Date.now();
                // Mark position as active
                this.activePositions.add(symbol);
                console.log(`✅ [RSI-FIBO] ${symbol} ${context.side} order filled @ ${context.entryPrice.toFixed(4)}`);
                return { action: 'filled', context };
            }
        }
        return null;
    }

    private calculateRSI(closes: number[], period: number): number[] {
        if (closes.length < period + 1) return [];
        
        const changes: number[] = [];
        for (let i = 1; i < closes.length; i++) {
            changes.push(closes[i] - closes[i - 1]);
        }

        let avgGain = 0;
        let avgLoss = 0;
        for (let i = 0; i < period; i++) {
            if (changes[i] > 0) avgGain += changes[i];
            else avgLoss += Math.abs(changes[i]);
        }
        avgGain /= period;
        avgLoss /= period;

        const rsi: number[] = [];
        rsi.push(100 - (100 / (1 + avgGain / (avgLoss === 0 ? 0.001 : avgLoss))));

        for (let i = period; i < changes.length; i++) {
            const gain = changes[i] > 0 ? changes[i] : 0;
            const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            rsi.push(100 - (100 / (1 + avgGain / (avgLoss === 0 ? 0.001 : avgLoss))));
        }

        return rsi;
    }

    private async getCurrentRSI(symbol: string): Promise<number | null> {
        try {
            const res = await axios.get(
                `${BASE_URL}/api/v2/mix/market/candles?symbol=${symbol}&granularity=4H&productType=USDT-FUTURES&limit=${RSI_PERIOD + 1}`
            );
            const rows = res.data.data || [];
            if (rows.length < RSI_PERIOD + 1) return null;
            
            const closes = rows.map((r: string[]) => parseFloat(r[4]));
            const rsi = this.calculateRSI(closes, RSI_PERIOD);
            return rsi[rsi.length - 1];
        } catch {
            return null;
        }
    }

    private calculatePositionSize(symbol: string, price: number): number {
        const riskPerTrade = parseFloat(process.env.RISK_PER_TRADE_PCT || '1');
        const equity = 1000;
        const riskAmount = equity * (riskPerTrade / 100);
        const slDistance = price * SL_PCT;
        const positionSize = riskAmount / slDistance;
        return Math.max(positionSize, 0.001);
    }

    private async placeLimitOrder(symbol: string, side: string, price: number, size: number): Promise<any> {
        return { orderId: `sim_${Date.now()}_${symbol}` };
    }
}

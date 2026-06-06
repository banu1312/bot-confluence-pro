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
    earlyCutTriggered: boolean;
    tpTriggered: boolean;
}

export class RsiFiboStrategy implements BaseStrategy {
    name = 'rsi_fibo';
    private activeContexts: Map<string, RsiFiboContext> = new Map();

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
        try {
            const res = await axios.get(
                `${BASE_URL}/api/v2/mix/market/candles?symbol=${symbol}&granularity=4H&productType=USDT-FUTURES&limit=${RSI_PERIOD + 5}`
            );
            const rows = res.data.data || [];
            if (rows.length < RSI_PERIOD + 1) return null;

            const closes = rows.map((r: string[]) => parseFloat(r[4]));
            const highs = rows.map((r: string[]) => parseFloat(r[2]));
            const lows = rows.map((r: string[]) => parseFloat(r[3]));
            const opens = rows.map((r: string[]) => parseFloat(r[1]));

            const rsi = this.calculateRSI(closes, RSI_PERIOD);
            const currentRsi = rsi[rsi.length - 1];
            const currentCandle = rows[rows.length - 1];
            const currentClose = parseFloat(currentCandle[4]);
            const currentHigh = parseFloat(currentCandle[2]);
            const currentLow = parseFloat(currentCandle[3]);
            const currentOpen = parseFloat(currentCandle[1]);

            if (currentRsi > RSI_OVERBOUGHT) {
                const upperWick = currentHigh - Math.max(currentClose, currentOpen);
                const lowerWick = Math.min(currentClose, currentOpen) - currentLow;
                if (upperWick > lowerWick) {
                    console.log(`📊 [RSI-FIBO] ${symbol} SHORT trigger: RSI=${currentRsi.toFixed(2)}, upperWick=${upperWick.toFixed(4)}, lowerWick=${lowerWick.toFixed(4)}`);
                    return {
                        triggered: true,
                        side: 'SHORT',
                        high4h: currentHigh,
                        low4h: currentLow,
                        rsiAtTrigger: currentRsi,
                        triggerTime: parseInt(currentCandle[0], 10),
                        fibo786: currentHigh - (currentHigh - currentLow) * 0.786
                    };
                }
            }

            if (currentRsi < RSI_OVERSOLD) {
                const upperWick = currentHigh - Math.max(currentClose, currentOpen);
                const lowerWick = Math.min(currentClose, currentOpen) - currentLow;
                if (lowerWick > upperWick) {
                    console.log(`📊 [RSI-FIBO] ${symbol} LONG trigger: RSI=${currentRsi.toFixed(2)}, upperWick=${upperWick.toFixed(4)}, lowerWick=${lowerWick.toFixed(4)}`);
                    return {
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

            return null;
        } catch (error: any) {
            console.error(`❌ [RSI-FIBO] HTF check error for ${symbol}: ${error.message}`);
            return null;
        }
    }

    async checkLTFEntry(symbol: string, triggerContext: any, candle15m: any): Promise<any> {
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
                earlyCutTriggered: false,
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

        if (context.filled && !context.earlyCutTriggered) {
            const close15m = candle15m?.close || currentPrice;
            const isBreakout = context.side === 'SHORT' 
                ? close15m > context.fibo786 
                : close15m < context.fibo786;
            
            if (isBreakout) {
                console.log(`⚠️ [RSI-FIBO] ${position.symbol} early cut: 15M close ${close15m.toFixed(4)} broke fibo ${context.fibo786.toFixed(4)}`);
                context.earlyCutTriggered = true;
                return { action: 'close', reason: 'EARLY_CUT' };
            }
        }

        if (context.filled && !context.tpTriggered) {
            const rsi4h = await this.getCurrentRSI(position.symbol);
            if (rsi4h !== null) {
                const tpCondition = context.side === 'SHORT' 
                    ? rsi4h < RSI_OVERSOLD 
                    : rsi4h > RSI_OVERBOUGHT;
                
                if (tpCondition) {
                    console.log(`🎯 [RSI-FIBO] ${position.symbol} TP triggered: RSI=${rsi4h.toFixed(2)}`);
                    context.tpTriggered = true;
                    return { action: 'close', reason: 'TP_RSI' };
                }
            }
        }

        if (context.filled) {
            const slHit = context.side === 'SHORT'
                ? currentPrice >= context.slPrice
                : currentPrice <= context.slPrice;
            
            if (slHit) {
                console.log(`🛑 [RSI-FIBO] ${position.symbol} hard SL hit @ ${currentPrice.toFixed(4)}`);
                return { action: 'close', reason: 'HARD_SL' };
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
                ? currentPrice <= context.entryPrice
                : currentPrice >= context.entryPrice;
            
            if (isFilled) {
                context.filled = true;
                context.fillPrice = context.entryPrice;
                context.fillTime = Date.now();
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

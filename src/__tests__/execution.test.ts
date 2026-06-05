import { ExecutionEngine } from '../execution';

describe('ExecutionEngine', () => {
    describe('formatPrice', () => {
        it('should format price correctly', () => {
            const spec = {
                pricePlace: 4,
                priceEndStep: 1,
                volumePlace: 2,
                sizeMultiplier: 0.001,
                minTradeNum: 0.001,
                minTradeUSDT: 0
            };
            // Access private method via prototype
            const formatPrice = (ExecutionEngine as any).formatPrice;
            expect(formatPrice(123.456789, spec)).toBe('123.4568');
        });

        it('should snap to priceEndStep', () => {
            const spec = {
                pricePlace: 2,
                priceEndStep: 5,
                volumePlace: 2,
                sizeMultiplier: 0.001,
                minTradeNum: 0.001,
                minTradeUSDT: 0
            };
            const formatPrice = (ExecutionEngine as any).formatPrice;
            expect(formatPrice(123.456, spec)).toBe('123.45');
        });
    });

    describe('formatQty', () => {
        it('should format qty correctly', () => {
            const spec = {
                pricePlace: 4,
                priceEndStep: 1,
                volumePlace: 2,
                sizeMultiplier: 0.001,
                minTradeNum: 0.001,
                minTradeUSDT: 0
            };
            const formatQty = (ExecutionEngine as any).formatQty;
            expect(formatQty(1.234567, spec)).toBe('1.23');
        });

        it('should return null for qty below minTradeNum', () => {
            const spec = {
                pricePlace: 4,
                priceEndStep: 1,
                volumePlace: 2,
                sizeMultiplier: 0.001,
                minTradeNum: 0.1,
                minTradeUSDT: 0
            };
            const formatQty = (ExecutionEngine as any).formatQty;
            expect(formatQty(0.05, spec)).toBeNull();
        });
    });

    describe('calculateDynamicQty', () => {
        it('should calculate qty based on risk', () => {
            // Mock specs
            const specs = new Map();
            specs.set('BTCUSDT', {
                pricePlace: 4,
                priceEndStep: 1,
                volumePlace: 2,
                sizeMultiplier: 0.001,
                minTradeNum: 0.001,
                minTradeUSDT: 0
            });
            (ExecutionEngine as any).specs = specs;

            const calculateDynamicQty = (ExecutionEngine as any).calculateDynamicQty;
            const qty = calculateDynamicQty('BTCUSDT', 100, 'LONG', 95, 1000);
            // riskAmount = 1000 * 0.01 = 10 USDT
            // slDistance = 5
            // rawQty = 10 / 5 = 2
            // formatQty(2) = 2.00
            expect(qty).toBeCloseTo(2, 1);
        });

        it('should return null for zero SL distance', () => {
            const specs = new Map();
            specs.set('BTCUSDT', {
                pricePlace: 4,
                priceEndStep: 1,
                volumePlace: 2,
                sizeMultiplier: 0.001,
                minTradeNum: 0.001,
                minTradeUSDT: 0
            });
            (ExecutionEngine as any).specs = specs;

            const calculateDynamicQty = (ExecutionEngine as any).calculateDynamicQty;
            const qty = calculateDynamicQty('BTCUSDT', 100, 'LONG', 100, 1000);
            expect(qty).toBeNull();
        });

        it('should return null for missing spec', () => {
            (ExecutionEngine as any).specs = new Map();
            const calculateDynamicQty = (ExecutionEngine as any).calculateDynamicQty;
            const qty = calculateDynamicQty('UNKNOWN', 100, 'LONG', 95, 1000);
            expect(qty).toBeNull();
        });
    });
});

import { calcRealizedR, StateManager, ActivePosition } from '../state';

describe('calcRealizedR', () => {
    it('should return 0 for zero distance', () => {
        const pos: ActivePosition = {
            symbol: 'BTCUSDT',
            side: 'LONG',
            entryPrice: 100,
            qty: 1,
            originalQty: 1,
            slPrice: 100,
            originalSL: 100,
            tpLevels: [110],
            tpHit: [false],
            slPlanId: null,
            tpPlanIds: [null],
            breakevenMoved: false,
            trailActivated: false
        };
        expect(calcRealizedR(pos)).toBe(0);
    });

    it('should calculate positive R for TP hit', () => {
        const pos: ActivePosition = {
            symbol: 'BTCUSDT',
            side: 'LONG',
            entryPrice: 100,
            qty: 1,
            originalQty: 1,
            slPrice: 95,
            originalSL: 95,
            tpLevels: [110],
            tpHit: [true],
            slPlanId: null,
            tpPlanIds: [null],
            breakevenMoved: false,
            trailActivated: false
        };
        const r = calcRealizedR(pos);
        expect(r).toBeCloseTo(2, 1); // (110-100)/(100-95) = 10/5 = 2
    });

    it('should calculate negative R for SL hit', () => {
        const pos: ActivePosition = {
            symbol: 'BTCUSDT',
            side: 'LONG',
            entryPrice: 100,
            qty: 1,
            originalQty: 1,
            slPrice: 95,
            originalSL: 95,
            tpLevels: [110],
            tpHit: [false],
            slPlanId: null,
            tpPlanIds: [null],
            breakevenMoved: false,
            trailActivated: false
        };
        const r = calcRealizedR(pos);
        expect(r).toBeCloseTo(-1, 1); // remaining 100% at SL = -1R
    });

    it('should return 0 when breakeven moved and no TP hit', () => {
        const pos: ActivePosition = {
            symbol: 'BTCUSDT',
            side: 'LONG',
            entryPrice: 100,
            qty: 1,
            originalQty: 1,
            slPrice: 100,
            originalSL: 95,
            tpLevels: [110],
            tpHit: [false],
            slPlanId: null,
            tpPlanIds: [null],
            breakevenMoved: true,
            trailActivated: false
        };
        const r = calcRealizedR(pos);
        expect(r).toBeCloseTo(0, 1);
    });
});

describe('StateManager', () => {
    beforeEach(() => {
        StateManager.positions = [];
        StateManager.dailyLoss = { date: '2026-06-06', realizedR: {} };
        StateManager.equityHistory = [];
        StateManager.drawdownHistory = [];
        StateManager.tradeMarkers = [];
    });

    it('should add position', () => {
        const pos: ActivePosition = {
            symbol: 'BTCUSDT',
            side: 'LONG',
            entryPrice: 100,
            qty: 1,
            originalQty: 1,
            slPrice: 95,
            originalSL: 95,
            tpLevels: [110],
            tpHit: [false],
            slPlanId: null,
            tpPlanIds: [null],
            breakevenMoved: false,
            trailActivated: false
        };
        StateManager.addPosition(pos);
        expect(StateManager.positions.length).toBe(1);
        expect(StateManager.find('BTCUSDT')).toBeDefined();
    });

    it('should remove position', () => {
        const pos: ActivePosition = {
            symbol: 'BTCUSDT',
            side: 'LONG',
            entryPrice: 100,
            qty: 1,
            originalQty: 1,
            slPrice: 95,
            originalSL: 95,
            tpLevels: [110],
            tpHit: [false],
            slPlanId: null,
            tpPlanIds: [null],
            breakevenMoved: false,
            trailActivated: false
        };
        StateManager.addPosition(pos);
        StateManager.removePosition('BTCUSDT');
        expect(StateManager.positions.length).toBe(0);
    });

    it('should detect halt when daily loss exceeded', () => {
        jest.spyOn(StateManager, 'rolloverIfNeeded').mockImplementation(() => {});
        StateManager.dailyLoss.realizedR['BTCUSDT'] = -5;
        expect(StateManager.isHalted('BTCUSDT', 3)).toBe(true);
    });

    it('should not halt when daily loss within limit', () => {
        StateManager.dailyLoss.realizedR['BTCUSDT'] = -2;
        expect(StateManager.isHalted('BTCUSDT', 3)).toBe(false);
    });

    it('should record trade marker', () => {
        StateManager.recordTradeMarker('entry', 'LONG', 0);
        expect(StateManager.tradeMarkers.length).toBe(1);
        expect(StateManager.tradeMarkers[0].type).toBe('entry');
    });

    it('should limit trade markers to 200', () => {
        for (let i = 0; i < 250; i++) {
            StateManager.recordTradeMarker('entry', 'LONG', 0);
        }
        expect(StateManager.tradeMarkers.length).toBe(200);
    });

    it('should record equity snapshot', () => {
        StateManager.updateAccount({ equity: 1000, available: 500, locked: 500, unrealizedPL: 0 });
        expect(StateManager.equityHistory.length).toBe(1);
        expect(StateManager.equityHistory[0].equity).toBe(1000);
    });

    it('should limit equity history to 500', () => {
        for (let i = 0; i < 600; i++) {
            StateManager.updateAccount({ equity: 1000 + i, available: 500, locked: 500, unrealizedPL: 0 });
        }
        expect(StateManager.equityHistory.length).toBe(500);
    });
});

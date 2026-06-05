import './server';
import { startWebsocket, updateWatchlist } from './websocket';
import { Screener } from './screener';
import { ExecutionEngine } from './execution';
import { StateManager } from './state';

const RECONCILE_MS = 30_000;
const RESCREEN_MS = 4 * 60 * 60 * 1000; // 4 hours
const BATCH_SIZE = 5; // Batasan jumlah koin per-proses untuk hemat RAM

async function initBot() {
    console.clear();
    console.log("=========================================");
    console.log("🦾 ALGO-BOT PRO: AI DYNAMIC SCREENER");
    if (process.env.DRY_RUN === 'true') {
        console.log("🧪 DRY-RUN MODE: orders will NOT be placed");
    }
    console.log(`📊 [RISK] Risk per trade: ${process.env.RISK_PER_TRADE_PCT || '1'}% of equity`);
    console.log(`📊 [ATR] ATR period: ${process.env.ATR_PERIOD || '14'}, SL multiplier: ${process.env.ATR_MULTIPLIER_SL || '2'}`);
    console.log(`📊 [TRAIL] Trailing stop: ${process.env.TRAIL_PCT || '0.005'}% after TP1`);
    console.log("=========================================\n");

    // 0. Load persisted state + contract specs (parallel)
    StateManager.load();
    await ExecutionEngine.loadContractSpecs();

    // Initial account snapshot for dashboard (don't wait for first reconcile)
    const initAcct = await ExecutionEngine.fetchAccountInfo();
    if (initAcct) StateManager.updateAccount(initAcct);

    // 1. Cari Top 40 koin paling liar
    const topCoins = await Screener.getTopTrendingCoins(40);
    console.log(`✅ Mendapatkan Top ${topCoins.length} Koin: ${topCoins.join(', ')}`);

    // 2. Suntik sejarah memori (50 candle ke belakang) — BATCHED untuk cegah OOM
    console.log("📚 Menyuntik data sejarah ke RAM bot (batched mode)...");
    const initialData: any = {};
    
    for (let i = 0; i < topCoins.length; i += BATCH_SIZE) {
        const batch = topCoins.slice(i, i + BATCH_SIZE);
        console.log(`   ⏳ Memproses sejarah koin ${i + 1} - ${Math.min(i + BATCH_SIZE, topCoins.length)}...`);
        
        const histories = await Promise.all(batch.map(c => Screener.injectMemory(c)));
        batch.forEach((coin, index) => {
            if (histories[index]) initialData[coin] = histories[index];
        });
        
        // Jeda waktu napas 500ms antar batch agar V8 Engine Garbage Collector bisa bekerja
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.log("✅ Proses suntik data selesai! Bot siap tempur tanpa delay.");

    // 3. Nyalakan Websocket
    startWebsocket(topCoins, initialData);

    // 4. Periodic reconciliation: detect partial fills (TP1 hit → move SL to BE)
    setInterval(async () => {
        const acct = await ExecutionEngine.fetchAccountInfo();
        if (acct) StateManager.updateAccount(acct);

        const exchangePositions = await ExecutionEngine.fetchOpenPositions();
        if (exchangePositions === null) return;

        const tracked = [...StateManager.positions];
        for (const pos of tracked) {
            const exchangeQty = exchangePositions.get(pos.symbol);

            if (exchangeQty === undefined) {
                StateManager.recordPositionClosed(pos);
                await ExecutionEngine.cancelAllPlansFor(pos);
                StateManager.removePosition(pos.symbol);
                continue;
            }

            if (exchangeQty < pos.originalQty * 0.95 && !pos.breakevenMoved) {
                console.log(`🎯 [TP1 HIT] ${pos.symbol}: qty ${pos.originalQty} → ${exchangeQty}`);
                // Get current price from market data (use last close)
                const currentPrice = pos.side === 'LONG'
                    ? (pos.tpLevels[0] ?? pos.entryPrice * 1.01)
                    : (pos.tpLevels[0] ?? pos.entryPrice * 0.99);
                await ExecutionEngine.moveSLToTrailing(pos, exchangeQty, currentPrice);
            }

            // Update trailing stop for positions that already have trail activated
            if (pos.trailActivated) {
                // Get current price from market data (use last close)
                const currentPrice = pos.side === 'LONG'
                    ? (pos.tpLevels[0] ?? pos.entryPrice * 1.01)
                    : (pos.tpLevels[0] ?? pos.entryPrice * 0.99);
                await ExecutionEngine.updateTrailingStop(pos, exchangeQty, currentPrice);
            }
        }

        StateManager.reconcile(new Set(exchangePositions.keys()));
    }, RECONCILE_MS);

    // Periodic re-screen: refresh watchlist dengan koin volatile terbaru (Batched juga)
    setInterval(async () => {
        if (StateManager.positions.length > 0) return;
        const newCoins = await Screener.getTopTrendingCoins(40);
        
        const newData: Record<string, any> = {};
        for (let i = 0; i < newCoins.length; i += BATCH_SIZE) {
            const batch = newCoins.slice(i, i + BATCH_SIZE);
            const histories = await Promise.all(batch.map(c => Screener.injectMemory(c)));
            batch.forEach((coin, index) => {
                if (histories[index]) newData[coin] = histories[index];
            });
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        updateWatchlist(newCoins, newData);
    }, RESCREEN_MS);
}

initBot();

# Multi-Strategy Trading Bot Architecture

## Overview
This project has been refactored from a single SMC (Smart Money Concept) strategy into a **Multi-Strategy Framework** that supports dynamic strategy selection per coin via `config.json`.

## Architecture

### Configuration
- **config.json** (root): Controls which strategy runs per coin
  - `default_strategy`: Fallback strategy for coins without override
  - `coin_overrides`: Per-coin strategy overrides (e.g., `"BTCUSDT": "smc"`)

### Strategy Interface
- **src/strategies/BaseStrategy.ts**: Abstract interface all strategies must implement
  - `name`: Strategy identifier
  - `scanDailyWatchlist()`: Returns coins to monitor
  - `checkHTFTrigger()`: Higher timeframe trigger detection
  - `checkLTFEntry()`: Lower timeframe entry execution
  - `manageActivePosition()`: Position management (SL, TP, trailing)

### Strategy Factory
- **src/strategies/StrategyFactory.ts**: Factory pattern to instantiate correct strategy per coin
  - `getStrategyInstance(symbol)`: Returns appropriate strategy instance
  - `reloadConfig()`: Reloads config.json at runtime

### Implemented Strategies

#### 1. SMC Strategy (`src/strategies/SmcStrategy.ts`)
- Original Smart Money Concept logic migrated from `src/smc.ts` and `src/scoring.ts`
- Implements `BaseStrategy` interface
- Uses FVG, Order Blocks, Liquidity Sweeps, Displacement, Inducement detection
- Multi-timeframe analysis (5m/15m LTF + 1H/4H HTF)

#### 2. RSI-FIBO Strategy (`src/strategies/RsiFiboStrategy.ts`)
- New mechanical strategy based on RSI 4H + Fibonacci 0.786
- **Scanner**: Filters coins by market cap rank 50-200 and highest 24h volatility
- **HTF Trigger (4H)**:
  - SHORT: RSI > 70 + upper wick > lower wick
  - LONG: RSI < 30 + lower wick > upper wick
- **LTF Entry (15M)**: Pending limit order at Fibonacci 0.786 level
- **Risk Management**:
  - Hard SL: 5% from entry (10x leverage = 50% max loss)
  - Early Cut: 15M close breaking fibo 0.786 triggers immediate market close
  - TP: Hold until 4H RSI reaches opposite extreme (<30 for shorts, >70 for longs)

### File Structure
```
/
├── config.json                    # Dynamic strategy configuration
├── CONTEXT.md                     # This file
├── src/
│   ├── strategies/
│   │   ├── BaseStrategy.ts        # Strategy interface
│   │   ├── StrategyFactory.ts     # Factory pattern
│   │   ├── SmcStrategy.ts         # SMC strategy implementation
│   │   └── RsiFiboStrategy.ts     # RSI-FIBO strategy implementation
│   ├── smc.ts                     # Core SMC primitives (unchanged)
│   ├── scoring.ts                 # Legacy scoring (delegates to SmcStrategy)
│   ├── backtest.ts                # Updated for multi-strategy backtesting
│   ├── websocket.ts               # Updated for multi-strategy live trading
│   ├── execution.ts               # Order execution (unchanged)
│   ├── state.ts                   # State management (unchanged)
│   ├── screener.ts                # Coin screener (unchanged)
│   └── index.ts                   # Main entry point
```

### Backtest Engine Updates
- **src/backtest.ts**: Now supports both strategies
  - Reads `config.json` to determine strategy per coin
  - SMC strategy: Uses existing multi-TP simulation
  - RSI-FIBO strategy: Simulates limit order fills, early cuts, and RSI-based TP
  - No look-ahead bias: All decisions based on historical data available at that time

### Live Trading Updates
- **src/websocket.ts**: Routes incoming candle data to appropriate strategy
  - SMC: Evaluates on 5m/15m candle closes
  - RSI-FIBO: Checks 4H closes for triggers, monitors 15M for fills and early cuts

### API Integration
- Bitget Futures API (v2)
- Endpoints used:
  - `/api/v2/mix/market/candles` - Historical candle data
  - `/api/v2/mix/market/tickers` - Current market data
  - `/api/v2/mix/order/place-order` - Order placement
  - `/api/v2/mix/order/detail` - Order status

## Next Steps
1. **Testing**: Run backtests for both strategies across 3 years of data
2. **Optimization**: Tune RSI-FIBO parameters (RSI thresholds, fibo levels, SL percentage)
3. **Risk Management**: Implement position sizing based on account equity
4. **Dashboard**: Update dashboard to show strategy-specific metrics
5. **Monitoring**: Add alerts for strategy switches and configuration changes
6. **Documentation**: Add JSDoc comments to all strategy methods
7. **Unit Tests**: Create tests for RSI calculation, fibo levels, and strategy logic

import { BaseStrategy } from './BaseStrategy';
import { SmcStrategy } from './SmcStrategy';
import { RsiFiboStrategy } from './RsiFiboStrategy';
import { EmaImpulseTrailStrategy } from './EmaImpulseTrailStrategy';
import * as fs from 'fs';
import * as path from 'path';

interface Config {
    default_strategy: string;
    coin_overrides: Record<string, string>;
}

let config: Config;

function loadConfig(): Config {
    if (config) return config;
    try {
        const configPath = path.join(__dirname, '..', '..', 'config.json');
        const raw = fs.readFileSync(configPath, 'utf-8');
        config = JSON.parse(raw);
        return config;
    } catch (error: any) {
        console.warn(`⚠️  Config load failed: ${error.message}. Using defaults.`);
        config = {
            default_strategy: 'rsi_fibo',
            coin_overrides: {}
        };
        return config;
    }
}

const strategyCache = new Map<string, BaseStrategy>();

export function getStrategyInstance(symbol: string): BaseStrategy {
    const cfg = loadConfig();
    const strategyName = cfg.coin_overrides[symbol] || cfg.default_strategy;
    
    const cacheKey = `${symbol}_${strategyName}`;
    if (strategyCache.has(cacheKey)) {
        return strategyCache.get(cacheKey)!;
    }

    let strategy: BaseStrategy;
    if (strategyName === 'smc') {
        strategy = new SmcStrategy();
    } else if (strategyName === 'ema_impulse_trail') {
        strategy = new EmaImpulseTrailStrategy();
    } else {
        strategy = new RsiFiboStrategy();
    }

    strategyCache.set(cacheKey, strategy);
    return strategy;
}

export function reloadConfig(): void {
    config = undefined as any;
    loadConfig();
}

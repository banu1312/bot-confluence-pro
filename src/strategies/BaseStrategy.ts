export interface BaseStrategy {
  name: string;
  scanDailyWatchlist(): Promise<string[]>;
  checkHTFTrigger(symbol: string, candle4h: any): Promise<any>;
  checkLTFEntry(symbol: string, triggerContext: any, candle15m: any): Promise<any>;
  manageActivePosition(position: any, currentPrice: number, candle4h: any, candle15m: any): Promise<any>;
}

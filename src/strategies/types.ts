import { Connection, PublicKey } from '@solana/web3.js';

export interface StrategyExecutionContext {
  connection: Connection;
  vaultPublicKey: PublicKey;
  availableBalanceUsd: number;
  marketData?: Record<string, any>;
  timestamp: number;
}

export interface StrategyResult {
  strategyName: string;
  success: boolean;
  actionTaken: 'BUY' | 'SELL' | 'STAKE' | 'UNSTAKE' | 'HOLD';
  inputToken: string;
  outputToken: string;
  amountIn: number;
  amountOut: number;
  transactionSignature?: string;
  yieldAprPct?: number;
  pnlUsd?: number;
  error?: string;
}

export interface Strategy {
  name: string;
  description: string;
  init(): Promise<void>;
  evaluate(context: StrategyExecutionContext): Promise<boolean>;
  execute(context: StrategyExecutionContext): Promise<StrategyResult>;
}

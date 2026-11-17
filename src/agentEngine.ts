import { Connection, PublicKey } from '@solana/web3.js';
import { SteveCapitalClient } from './steveCapitalSdk';

export interface AgentEngineOptions {
  connection: Connection;
  config: any;
}

export class AgentEngine {
  public connection: Connection;
  public config: any;
  public steveClient: SteveCapitalClient;
  private vaultPublicKey: PublicKey;
  private spendingLimit: number = 25_000_000;
  private currentSpend: number = 0;
  private strategies: Map<string, any> = new Map();
  private schedulerTimer: NodeJS.Timeout | null = null;
  private schedulerRunning: boolean = false;

  constructor(options: AgentEngineOptions) {
    this.connection = options.connection;
    this.config = options.config;
    this.steveClient = new SteveCapitalClient();
    this.vaultPublicKey = new PublicKey('Vault11111111111111111111111111111111111111');
  }

  public async initialize(): Promise<void> {
    await this.steveClient.deployAgent({
      name: 'RazeAutonomousFleet',
      network: 'devnet',
    });
  }

  public async fundVault(amount: number): Promise<boolean> {
    return await this.steveClient.fundVault(amount);
  }

  public async getVaultBalance(): Promise<number> {
    return await this.steveClient.getVaultBalance();
  }

  public async setSpendingLimit(limit: number): Promise<void> {
    this.spendingLimit = limit;
    this.currentSpend = 0;
  }

  public async getGuardrails(): Promise<{ spendingLimit: number; riskParameters: any }> {
    return {
      spendingLimit: this.spendingLimit,
      riskParameters: this.config?.riskParameters ?? { maxExposurePct: 25 },
    };
  }

  public async attemptSpend(amount: number): Promise<void> {
    if (this.currentSpend + amount > this.spendingLimit) {
      throw new Error(
        `Spending limit exceeded: attempted ${this.currentSpend + amount} > allowed ${this.spendingLimit}`
      );
    }
    this.currentSpend += amount;
  }

  public registerStrategy(name: string, strategy: any): void {
    this.strategies.set(name, strategy);
  }

  public getRegisteredStrategy(name: string): any {
    return this.strategies.get(name);
  }

  public async executeStrategy(name: string): Promise<any> {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      throw new Error(`Strategy ${name} not found`);
    }
    return await strategy.execute();
  }

  public async monitorMarkets(): Promise<void> {
    // Queries on-chain prices and risk parameters
  }

  public async executeScheduledStrategies(): Promise<void> {
    for (const [name, strategy] of this.strategies.entries()) {
      if (typeof strategy.execute === 'function') {
        await strategy.execute();
      }
    }
  }

  public startScheduler(intervalMs: number = 30_000): void {
    this.schedulerRunning = true;
    this.schedulerTimer = setInterval(async () => {
      await this.monitorMarkets();
      await this.executeScheduledStrategies();
    }, intervalMs);
  }

  public stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.schedulerRunning = false;
  }

  public isSchedulerRunning(): boolean {
    return this.schedulerRunning;
  }

  public getVaultPublicKey(): PublicKey {
    return this.vaultPublicKey;
  }
}

import { PublicKey } from '@solana/web3.js';

export interface PermissionSet {
  canSwap: boolean;
  canYieldFarm: boolean;
  maxSpend: number;
}

export class SubAgent {
  public totalSpent = 0;

  constructor(
    public name: string,
    public permissions: PermissionSet,
    public delegatedVault: PublicKey,
    private engine: any
  ) {}

  public async attemptSpend(amount: number): Promise<void> {
    if (this.totalSpent + amount > this.permissions.maxSpend) {
      throw new Error(
        `Spending limit exceeded: ${this.totalSpent + amount} > ${this.permissions.maxSpend}`
      );
    }
    this.totalSpent += amount;
  }
}

export class SubAgentManager {
  constructor(private engine: any) {}

  public async createSubAgent(name: string, permissions: PermissionSet): Promise<SubAgent> {
    const subAgent = new SubAgent(name, permissions, this.engine.getVaultPublicKey(), this.engine);
    
    // Register on-chain / with Steve Capital SDK
    if (this.engine.steveClient && this.engine.steveClient.registerSubAgent) {
      await this.engine.steveClient.registerSubAgent({
        name,
        permissions,
        delegatedVault: this.engine.getVaultPublicKey().toBase58(),
      });
    }

    return subAgent;
  }
}

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { Provider, Program, AnchorProvider } from '@solana/anchor';
import { SteveCapitalClient, Agent as SteveAgent, Vault as SteveVault, Permission as StevePermission } from '@stevecapital/sdk';
import { SAPMCP } from '@oobe/protocol';
import { KaminoYieldStrategy } from './strategies/kaminoYield';
import { JupiterSpotStrategy } from './strategies/jupiterSpot';
import { Strategy, StrategyExecutionContext } from './strategies/types';
import { SubAgentConfig, AgentConfig, SpendingLimits, RiskParameters, ExecutionMandates } from './config';
import cron from 'node-cron';
import { createLogger, transports, format } from 'winston';
import fs from 'fs';
import path from 'path';

// -----------------------------------------------------------------------------
// Logger Setup
// -----------------------------------------------------------------------------
const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
    }),
    new transports.File({ filename: 'logs/agent.log' })
  ],
});

// -----------------------------------------------------------------------------
// Guardrail Engine
// -----------------------------------------------------------------------------
class GuardrailEngine {
  private dailySpent: Map<string, number> = new Map(); // tokenMint => amount spent today
  private lastReset: Date = new Date();

  constructor(
    private readonly spendingLimits: SpendingLimits,
    private readonly riskParameters: RiskParameters,
    private readonly executionMandates: ExecutionMandates
  ) {}

  /**
   * Reset daily counters at midnight UTC.
   */
  private resetIfNeeded(): void {
    const now = new Date();
    if (now.getUTCDate() !== this.lastReset.getUTCDate()) {
      this.dailySpent.clear();
      this.lastReset = now;
      logger.info('Daily spending counters reset');
    }
  }

  /**
   * Verify that a proposed trade respects spending limits.
   */
  public checkSpendingLimit(tokenMint: string, amount: number): void {
    this.resetIfNeeded();
    const limit = this.spendingLimits[tokenMint];
    if (limit === undefined) {
      throw new Error(`No spending limit configured for token ${tokenMint}`);
    }
    const spent = this.dailySpent.get(tokenMint) ?? 0;
    if (spent + amount > limit) {
      throw new Error(
        `Spending limit exceeded for ${tokenMint}: ${spent + amount} > ${limit}`
      );
    }
    this.dailySpent.set(tokenMint, spent + amount);
  }

  /**
   * Verify that a proposed exposure respects risk parameters.
   */
  public checkRisk(exposureUsd: number): void {
    const { maxTotalExposureUsd } = this.riskParameters;
    if (exposureUsd > maxTotalExposureUsd) {
      throw new Error(
        `Risk limit breached: exposure ${exposureUsd} > max ${maxTotalExposureUsd}`
      );
    }
  }

  /**
   * Verify that the token pair is allowed by execution mandates.
   */
  public checkMandate(baseMint: string, quoteMint: string): void {
    const { allowedPairs } = this.executionMandates;
    const pair = `${baseMint}:${quoteMint}`;
    if (!allowedPairs.includes(pair)) {
      throw new Error(`Pair ${pair} is not permitted by execution mandates`);
    }
  }
}

// -----------------------------------------------------------------------------
// Sub‑Agent Manager
// -----------------------------------------------------------------------------
class SubAgentManager {
  private readonly client: SteveCapitalClient;

  constructor(client: SteveCapitalClient) {
    this.client = client;
  }

  /**
   * Creates a sub‑agent with delegated vault permissions.
   */
  public async createSubAgent(
    parentAgent: SteveAgent,
    config: SubAgentConfig
  ): Promise<SteveAgent> {
    logger.info('Creating sub‑agent %s', config.name);
    const subAgent = await this.client.createAgent({
      name: config.name,
      description: config.description,
      owner: parentAgent.owner,
    });

    // Delegate vault permissions
    const permission = new StevePermission({
      vault: new PublicKey(config.delegatedVault),
      authority: subAgent.publicKey,
      permissions: config.permissions,
    });
    await this.client.grantPermission(permission);
    logger.info('Sub‑agent %s created with delegated vault %s', config.name, config.delegatedVault);
    return subAgent;
  }
}

// -----------------------------------------------------------------------------
// Agent Engine
// -----------------------------------------------------------------------------
export class AgentEngine {
  private connection!: Connection;
  private provider!: Provider;
  private steveClient!: SteveCapitalClient;
  private vault!: SteveVault;
  private guardrailEngine!: GuardrailEngine;
  private strategies: Map<string, Strategy> = new Map();
  private subAgentManager!: SubAgentManager;
  private cronJobs: cron.ScheduledTask[] = [];

  constructor(private readonly config: AgentConfig) {}

  /**
   * Initialise Solana connection, Steve Capital client, vault and guardrails.
   */
  public async init(): Promise<void> {
    logger.info('Initialising Agent Engine');
    this.connection = new Connection(this.config.rpcUrl, 'confirmed');

    const walletKeypair = this.loadKeypair(this.config.walletKeypairPath);
    const anchorProvider = new AnchorProvider(this.connection, {
      publicKey: walletKeypair.publicKey,
      signTransaction: async (tx: Transaction) => {
        tx.partialSign(walletKeypair);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        txs.forEach((tx) => tx.partialSign(walletKeypair));
        return txs;
      },
    }, { preflightCommitment: 'confirmed' });
    this.provider = anchorProvider;

    this.steveClient = new SteveCapitalClient({
      provider: this.provider,
      network: this.config.network,
    });

    this.vault = await this.steveClient.getVault(new PublicKey(this.config.vaultPublicKey));
    logger.info('Vault loaded: %s', this.vault.publicKey.toBase58());

    this.guardrailEngine = new GuardrailEngine(
      this.config.spendingLimits,
      this.config.riskParameters,
      this.config.executionMandates
    );

    this.subAgentManager = new SubAgentManager(this.steveClient);

    await this.registerStrategies();
    this.scheduleJobs();
    logger.info('Agent Engine initialisation complete');
  }

  /**
   * Load a Solana keypair from a JSON file.
   */
  private loadKeypair(filePath: string): Keypair {
    const absolutePath = path.resolve(filePath);
    const secretKeyString = fs.readFileSync(absolutePath, { encoding: 'utf8' });
    const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
    return Keypair.fromSecretKey(secretKey);
  }

  /**
   * Register all strategies defined in the configuration.
   */
  private async registerStrategies(): Promise<void> {
    logger.info('Registering strategies');
    for (const stratCfg of this.config.strategies) {
      let strategyInstance: Strategy;
      switch (stratCfg.type) {
        case 'kamino-yield':
          strategyInstance = new KaminoYieldStrategy(this.provider, this.vault, stratCfg.params);
          break;
        case 'jupiter-spot':
          strategyInstance = new JupiterSpotStrategy(this.provider, this.vault, stratCfg.params);
          break;
        default:
          throw new Error(`Unsupported strategy type: ${stratCfg.type}`);
      }
      this.strategies.set(stratCfg.id, strategyInstance);
      logger.info('Strategy %s (%s) registered', stratCfg.id, stratCfg.type);
    }
  }

  /**
   * Schedule recurring jobs (market monitoring, strategy execution, etc.).
   */
  private scheduleJobs(): void {
    logger.info('Scheduling cron jobs');

    // Market monitoring & strategy execution every 5 minutes
    const marketJob = cron.schedule('*/5 * * * *', async () => {
      try {
        await this.runAllStrategies();
      } catch (err) {
        logger.error('Error during scheduled strategy execution: %s', err);
      }
    });
    this.cronJobs.push(marketJob);

    // Daily reset of guardrail counters at 00:00 UTC
    const resetJob = cron.schedule('0 0 * * *', () => {
      logger.info('Executing daily guardrail reset');
      // GuardrailEngine resets lazily; force a reset by touching the date
      (this.guardrailEngine as any).lastReset = new Date(0);
    });
    this.cronJobs.push(resetJob);
  }

  /**
   * Execute all registered strategies respecting guardrails.
   */
  private async runAllStrategies(): Promise<void> {
    logger.info('Running all strategies');
    for (const [id, strategy] of this.strategies.entries()) {
      try {
        const ctx: StrategyExecutionContext = {
          provider: this.provider,
          vault: this.vault,
          guardrails: this.guardrailEngine,
          logger,
        };
        await strategy.execute(ctx);
        logger.info('Strategy %s executed successfully', id);
      } catch (err) {
        logger.error('Strategy %s failed: %s', id, err);
      }
    }
  }

  /**
   * Create and register a sub‑agent according to configuration.
   */
  public async provisionSubAgent(subConfig: SubAgentConfig): Promise<SteveAgent> {
    const parentAgent = await this.steveClient.getAgent(this.config.agentPublicKey);
    const subAgent = await this.subAgentManager.createSubAgent(parentAgent, subConfig);
    logger.info('Sub‑agent %s provisioned', subConfig.name);
    return subAgent;
  }

  /**
   * Gracefully stop all scheduled jobs.
   */
  public async shutdown(): Promise<void> {
    logger.info('Shutting down Agent Engine');
    for (const job of this.cronJobs) {
      job.stop();
    }
    // Additional cleanup (e.g., close connections) can be added here.
  }
}

// -----------------------------------------------------------------------------
// Entrypoint
// -----------------------------------------------------------------------------
(async () => {
  try {
    // Dynamically import configuration to avoid circular dependencies.
    const { config } = await import('./config');
    const engine = new AgentEngine(config);
    await engine.init();

    // Example: provision a sub‑agent for private swaps if configured.
    if (config.subAgents && config.subAgents.length > 0) {
      for (const subCfg of config.subAgents) {
        await engine.provisionSubAgent(subCfg);
      }
    }

    // Keep the process alive – the cron jobs drive the agent.
    process.once('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down...');
      await engine.shutdown();
      process.exit(0);
    });
    process.once('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down...');
      await engine.shutdown();
      process.exit(0);
    });
  } catch (err) {
    logger.error('Fatal error during agent startup: %s', err);
    process.exit(1);
  }
})();
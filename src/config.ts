import * as fs from 'fs';
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';
import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';

// Load .env file early so that process.env is populated
loadDotEnv({ path: path.resolve(process.cwd(), '.env') });

/**
 * Environment schema definition using Zod.
 * All variables are required; defaults are applied where appropriate.
 */
const EnvSchema = z.object({
  // Core network configuration
  NETWORK: z.enum(['devnet', 'testnet', 'mainnet-beta']).default('devnet'),
  RPC_URL: z.string().url().default('https://api.devnet.solana.com'),

  // Wallet / keypair configuration
  WALLET_KEYPAIR_PATH: z
    .string()
    .default(path.resolve(process.cwd(), 'keys', 'agent-keypair.json')),

  // Vault configuration
  VAULT_ADDRESS: z.string().refine(PublicKey.isOnCurve, {
    message: 'VAULT_ADDRESS must be a valid Solana public key',
  }),
  FUNDING_TOKEN_MINT: z
    .string()
    .refine(PublicKey.isOnCurve, {
      message: 'FUNDING_TOKEN_MINT must be a valid Solana public key',
    })
    .default('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC devnet

  MIN_FUNDING_USD: z
    .string()
    .transform((val) => Number(val))
    .refine((n) => !Number.isNaN(n) && n >= 0, {
      message: 'MIN_FUNDING_USD must be a non‑negative number',
    })
    .default('20'),

  // Guardrail configuration
  SPENDING_LIMIT_USD: z
    .string()
    .transform((val) => Number(val))
    .refine((n) => !Number.isNaN(n) && n > 0, {
      message: 'SPENDING_LIMIT_USD must be a positive number',
    })
    .default('5000'),

  DAILY_SPENDING_LIMIT_USD: z
    .string()
    .transform((val) => Number(val))
    .refine((n) => !Number.isNaN(n) && n > 0, {
      message: 'DAILY_SPENDING_LIMIT_USD must be a positive number',
    })
    .default('1000'),

  MAX_RISK_PCT: z
    .string()
    .transform((val) => Number(val))
    .refine((n) => !Number.isNaN(n) && n > 0 && n <= 100, {
      message: 'MAX_RISK_PCT must be between 0 and 100',
    })
    .default('25'),

  // Strategy toggles & parameters
  ENABLE_KAMINO: z
    .string()
    .transform((val) => val.toLowerCase() === 'true')
    .default('true'),
  KAMINO_POOL_ID: z.string().optional(),
  KAMINO_MIN_YIELD_PCT: z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : undefined))
    .refine((n) => n === undefined || (!Number.isNaN(n) && n >= 0), {
      message: 'KAMINO_MIN_YIELD_PCT must be a non‑negative number',
    })
    .default('5'),

  ENABLE_JUPITER: z
    .string()
    .transform((val) => val.toLowerCase() === 'true')
    .default('true'),
  JUPITER_SLIPPAGE_BPS: z
    .string()
    .transform((val) => Number(val))
    .refine((n) => !Number.isNaN(n) && n >= 0, {
      message: 'JUPITER_SLIPPAGE_BPS must be a non‑negative integer',
    })
    .default('30'),

  // Sub‑agent configuration
  ENABLE_SUB_AGENT: z
    .string()
    .transform((val) => val.toLowerCase() === 'true')
    .default('false'),
  SUB_AGENT_DELEGATED_VAULT: z.string().optional(),
  SUB_AGENT_PERMISSIONS: z
    .string()
    .optional()
    .transform((val) => (val ? val.split(',').map((s) => s.trim()) : [])),

  // Scheduler configuration
  CRON_EXPRESSION: z
    .string()
    .default('0 */5 * * * *') // every 5 minutes
    .refine(
      (expr) => {
        // Very light validation – a full cron parser is overkill here
        return typeof expr === 'string' && expr.trim().length > 0;
      },
      { message: 'CRON_EXPRESSION must be a non‑empty string' }
    ),

  // Logging
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),
});

/**
 * Parse and validate environment variables.
 * Throws a detailed error if validation fails.
 */
const env = EnvSchema.parse(process.env);

/**
 * Helper to load a Solana keypair from a JSON file.
 * Returns a Uint8Array suitable for @solana/web3.js Keypair.fromSecretKey.
 */
function loadKeypair(filePath: string): Uint8Array {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Keypair file not found at ${absolutePath}`);
  }
  const raw = fs.readFileSync(absolutePath, { encoding: 'utf8' });
  let secretKey: number[];
  try {
    secretKey = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse keypair JSON at ${absolutePath}: ${e}`);
  }
  if (!Array.isArray(secretKey) || secretKey.length !== 64) {
    throw new Error(
      `Invalid keypair format at ${absolutePath}: expected an array of 64 numbers`
    );
  }
  return Uint8Array.from(secretKey);
}

/**
 * Typed configuration object exposed to the rest of the application.
 */
export const config = {
  // Core
  network: env.NETWORK,
  rpcUrl: env.RPC_URL,

  // Wallet
  walletKeypairPath: env.WALLET_KEYPAIR_PATH,
  walletSecretKey: loadKeypair(env.WALLET_KEYPAIR_PATH),

  // Vault
  vault: {
    address: new PublicKey(env.VAULT_ADDRESS),
    fundingTokenMint: new PublicKey(env.FUNDING_TOKEN_MINT),
    minFundingUsd: env.MIN_FUNDING_USD,
  },

  // Guardrails
  guardrails: {
    spendingLimitUsd: env.SPENDING_LIMIT_USD,
    dailySpendingLimitUsd: env.DAILY_SPENDING_LIMIT_USD,
    maxRiskPct: env.MAX_RISK_PCT,
    allowedStrategies: (() => {
      const strategies: string[] = [];
      if (env.ENABLE_KAMINO) strategies.push('kamino');
      if (env.ENABLE_JUPITER) strategies.push('jupiter');
      return strategies;
    })(),
  },

  // Strategies
  strategies: {
    kamino: {
      enabled: env.ENABLE_KAMINO,
      poolId: env.KAMINO_POOL_ID ?? '',
      minYieldPct: env.KAMINO_MIN_YIELD_PCT,
    },
    jupiter: {
      enabled: env.ENABLE_JUPITER,
      slippageBps: env.JUPITER_SLIPPAGE_BPS,
    },
  },

  // Sub‑Agent
  subAgent: {
    enabled: env.ENABLE_SUB_AGENT,
    delegatedVault: env.SUB_AGENT_DELEGATED_VAULT
      ? new PublicKey(env.SUB_AGENT_DELEGATED_VAULT)
      : null,
    permissions: env.SUB_AGENT_PERMISSIONS,
  },

  // Scheduler
  schedule: {
    cronExpression: env.CRON_EXPRESSION,
  },

  // Logging
  logging: {
    level: env.LOG_LEVEL,
  },
} as const;

/**
 * Export a helper to retrieve the public key of the agent's wallet.
 */
export const AGENT_PUBLIC_KEY = new PublicKey(
  // Derive from secret key – this is safe because the secret key is already loaded
  // and the Keypair constructor is cheap.
  (() => {
    const { Keypair } = require('@solana/web3.js');
    return new Keypair({ secretKey: config.walletSecretKey }).publicKey;
  })()
);

/**
 * Freeze the exported config to prevent accidental mutation at runtime.
 */
Object.freeze(config);
Object.freeze(config.guardrails);
Object.freeze(config.strategies);
Object.freeze(config.subAgent);
Object.freeze(config.schedule);
Object.freeze(config.logging);
Object.freeze(config.vault);
Object.freeze(config.logging);
Object.freeze(AGENT_PUBLIC_KEY);
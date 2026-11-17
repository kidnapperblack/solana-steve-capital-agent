import { AgentEngine } from '../src/agentEngine';
import config from '../src/config';
import { KaminoYieldStrategy } from '../src/strategies/kamino';
import { JupiterSpotStrategy } from '../src/strategies/jupiter';
import { SubAgentManager, PermissionSet } from '../src/subAgentManager';
import { PublicKey, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { jest } from '@jest/globals';

// Mock external SDKs and network calls
jest.mock('@solana/web3.js', () => {
  const actual = jest.requireActual('@solana/web3.js');
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(() => ({
      getBalance: jest.fn().mockResolvedValue(0),
      getParsedTokenAccountsByOwner: jest.fn().mockResolvedValue({
        value: [],
      }),
    })),
    PublicKey: actual.PublicKey,
    LAMPORTS_PER_SOL: actual.LAMPORTS_PER_SOL,
  };
});

jest.mock('../src/steveCapitalSdk', () => ({
  SteveCapitalClient: jest.fn().mockImplementation(() => ({
    deployAgent: jest.fn().mockResolvedValue({ agentId: 'test-agent-id' }),
    fundVault: jest.fn().mockResolvedValue(true),
    setGuardrails: jest.fn().mockResolvedValue(true),
    getGuardrails: jest.fn().mockResolvedValue({
      spendingLimit: config.spendingLimit,
      riskParameters: config.riskParameters,
    }),
    registerStrategy: jest.fn().mockResolvedValue(true),
    getVaultBalance: jest.fn().mockResolvedValue(25_000_000), // 25 USDC (6 decimals)
  })),
}));

// Mock strategy execution SDKs
jest.mock('../src/strategies/kamino', () => ({
  KaminoYieldStrategy: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue({ profit: 0.5 }),
  })),
}));

jest.mock('../src/strategies/jupiter', () => ({
  JupiterSpotStrategy: jest.fn().mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue({ profit: 0.2 }),
  })),
}));

// Helper to create a fresh AgentEngine instance per test
async function createAgentEngine(): Promise<AgentEngine> {
  const engine = new AgentEngine({
    connection: new Connection('https://api.devnet.solana.com', 'confirmed'),
    config,
  });
  await engine.initialize();
  return engine;
}

describe('AgentEngine Integration Tests', () => {
  beforeAll(() => {
    jest.setTimeout(30_000);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('should initialize agent with devnet connection and config', async () => {
    const engine = await createAgentEngine();

    expect(engine).toBeDefined();
    expect(engine.connection).toBeInstanceOf(Connection);
    expect(engine.config).toMatchObject(config);
    // Verify that the Steve Capital client attempted deployment
    const { SteveCapitalClient } = await import('../src/steveCapitalSdk');
    const clientInstance = (SteveCapitalClient as jest.Mock).mock.results[0].value;
    expect(clientInstance.deployAgent).toHaveBeenCalledTimes(1);
  });

  test('should fund vault with at least 20 USDC on devnet', async () => {
    const engine = await createAgentEngine();

    // Simulate funding call
    const funded = await engine.fundVault(20_000_000); // 20 USDC (6 decimals)
    expect(funded).toBe(true);

    // Verify vault balance >= 20 USDC
    const balance = await engine.getVaultBalance();
    expect(balance).toBeGreaterThanOrEqual(20_000_000);
  });

  test('should enforce spending limit guardrail', async () => {
    const engine = await createAgentEngine();

    // Set a low spending limit to test enforcement
    const newLimit = 5_000_000; // 5 USDC
    await engine.setSpendingLimit(newLimit);
    const guardrails = await engine.getGuardrails();
    expect(guardrails.spendingLimit).toBe(newLimit);

    // Attempt a spend that exceeds the limit
    await expect(engine.attemptSpend(6_000_000)).rejects.toThrow(
      /Spending limit exceeded/
    );

    // Spend within limit should succeed
    await expect(engine.attemptSpend(4_000_000)).resolves.not.toThrow();
  });

  test('should register and execute Kamino yield farming strategy', async () => {
    const engine = await createAgentEngine();

    const kaminoStrategy = new KaminoYieldStrategy({
      clientId: 'test-client',
      vaultAddress: new PublicKey('B1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2'),
    });

    await engine.registerStrategy('kamino-yield', kaminoStrategy);
    const registered = engine.getRegisteredStrategy('kamino-yield');
    expect(registered).toBe(kaminoStrategy);

    const result = await engine.executeStrategy('kamino-yield');
    expect(result).toHaveProperty('profit');
    expect(result.profit).toBeGreaterThan(0);
    // Verify underlying SDK call
    expect(kaminoStrategy.execute).toHaveBeenCalledTimes(1);
  });

  test('should register and execute Jupiter spot trading strategy', async () => {
    const engine = await createAgentEngine();

    const jupiterStrategy = new JupiterSpotStrategy({
      clientId: 'test-client',
      vaultAddress: new PublicKey('C1d2e3f4g5h6i7j8k9l0m1n2o3p4q5r6s7t8u9v0w1x2'),
    });

    await engine.registerStrategy('jupiter-spot', jupiterStrategy);
    const registered = engine.getRegisteredStrategy('jupiter-spot');
    expect(registered).toBe(jupiterStrategy);

    const result = await engine.executeStrategy('jupiter-spot');
    expect(result).toHaveProperty('profit');
    expect(result.profit).toBeGreaterThan(0);
    expect(jupiterStrategy.execute).toHaveBeenCalledTimes(1);
  });

  test('should schedule periodic market monitoring and execution', async () => {
    jest.useFakeTimers();
    const engine = await createAgentEngine();

    const monitorMock = jest.spyOn(engine, 'monitorMarkets').mockResolvedValue(undefined);
    const executeMock = jest.spyOn(engine, 'executeScheduledStrategies').mockResolvedValue(undefined);

    // Start scheduler with a 5‑second interval for the test
    engine.startScheduler(5_000);
    expect(engine.isSchedulerRunning()).toBe(true);

    // Fast‑forward time to trigger two intervals
    jest.advanceTimersByTime(10_500);
    await Promise.resolve(); // allow pending promises to resolve

    expect(monitorMock).toHaveBeenCalledTimes(2);
    expect(executeMock).toHaveBeenCalledTimes(2);

    // Stop scheduler and verify no further calls
    engine.stopScheduler();
    expect(engine.isSchedulerRunning()).toBe(false);
    monitorMock.mockClear();
    executeMock.mockClear();

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();

    expect(monitorMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  test('should create sub‑agent with delegated vault and restricted permissions', async () => {
    const engine = await createAgentEngine();
    const subAgentMgr = new SubAgentManager(engine);

    const permissions: PermissionSet = {
      canSwap: true,
      canYieldFarm: false,
      maxSpend: 2_000_000, // 2 USDC
    };

    const subAgent = await subAgentMgr.createSubAgent('private-swapper', permissions);
    expect(subAgent).toBeDefined();
    expect(subAgent.name).toBe('private-swapper');
    expect(subAgent.permissions).toMatchObject(permissions);
    expect(subAgent.delegatedVault).toBe(engine.getVaultPublicKey());

    // Verify that the sub‑agent respects its spend limit
    await expect(subAgent.attemptSpend(3_000_000)).rejects.toThrow(
      /Spending limit exceeded/
    );
    await expect(subAgent.attemptSpend(1_500_000)).resolves.not.toThrow();

    // Ensure the parent engine registers the sub‑agent on‑chain
    const { SteveCapitalClient } = await import('../src/steveCapitalSdk');
    const clientInstance = (SteveCapitalClient as jest.Mock).mock.results[0].value;
    expect(clientInstance.registerSubAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'private-swapper',
        permissions,
        delegatedVault: engine.getVaultPublicKey().toBase58(),
      })
    );
  });
});
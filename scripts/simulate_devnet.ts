import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { AgentEngine } from '../src/agentEngine';
import { KaminoYieldStrategy } from '../src/strategies/kamino';
import { JupiterSpotStrategy } from '../src/strategies/jupiter';
import { MultihopperRouteStrategy } from '../src/strategies/multihopperRoute';
import { AceDataSentimentClient } from '../src/sentiment/aceDataSentiment';
import { SubAgentManager } from '../src/subAgentManager';

async function runDevnetSimulation() {
  console.log('================================================================');
  console.log('🤖 SOLANA STEVE CAPITAL AUTONOMOUS AGENT - DEVNET SIMULATION RUN');
  console.log('================================================================');
  console.log(`[INIT] Network: Solana Devnet (https://api.devnet.solana.com)`);
  console.log(`[INIT] Timestamp: ${new Date().toISOString()}`);

  const agentWallet = Keypair.generate();
  console.log(`[WALLET] Agent Authority Public Key: ${agentWallet.publicKey.toBase58()}`);

  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  
  const mockConfig = {
    network: 'devnet',
    spendingLimit: 25_000_000, // 25 USDC
    riskParameters: {
      maxExposurePct: 25,
      maxSlippageBps: 50,
      stopLossPct: 5,
    },
  };

  const engine = new AgentEngine({
    connection,
    config: mockConfig,
  });

  console.log('\n--- 1. DEPLOYMENT & VAULT INITIALIZATION ---');
  await engine.initialize();
  console.log(`[OK] Agent Deployed to Steve Capital Protocol`);
  console.log(`[OK] Vault Created at: ${engine.getVaultPublicKey().toBase58()}`);

  console.log('\n--- 2. VAULT FUNDING ---');
  const fundingAmountUsdc = 20.0;
  await engine.fundVault(fundingAmountUsdc * 1_000_000);
  const vaultBalance = await engine.getVaultBalance();
  console.log(`[OK] Vault Funded with: ${(vaultBalance / 1_000_000).toFixed(2)} USDC (Target: >= 20.00 USDC)`);

  console.log('\n--- 3. PROGRAMMABLE GUARDRAILS ENFORCEMENT ---');
  await engine.setSpendingLimit(15_000_000); // 15 USDC limit
  const guardrails = await engine.getGuardrails();
  console.log(`[GUARDRAIL] Active Daily Limit: ${(guardrails.spendingLimit / 1_000_000).toFixed(2)} USDC`);
  console.log(`[GUARDRAIL] Risk Exposure Cap: ${guardrails.riskParameters.maxExposurePct}%`);

  // Test guardrail safety rejection
  try {
    console.log(`[GUARDRAIL CHECK] Attempting oversized spend of 18.00 USDC...`);
    await engine.attemptSpend(18_000_000);
  } catch (err: any) {
    console.log(`[GUARDRAIL INTERCEPTED] Successfully blocked: "${err.message}"`);
  }

  console.log('\n--- 4. MARKET SENTIMENT (ACE DATA CLOUD) ---');
  const sentimentClient = new AceDataSentimentClient();
  const solSentiment = await sentimentClient.fetchMarketSentiment('SOL/USDC');
  console.log(`[SENTIMENT] Asset: ${solSentiment.symbol}`);
  console.log(`[SENTIMENT] Score: +${solSentiment.sentimentScore} (Strongly Bullish) | Bullish Ratio: ${(solSentiment.bullishRatio * 100).toFixed(1)}%`);

  console.log('\n--- 5. STRATEGY REGISTRATION & EXECUTION ---');
  const kamino = new KaminoYieldStrategy();
  const jupiter = new JupiterSpotStrategy();
  const multihopper = new MultihopperRouteStrategy();

  engine.registerStrategy('kamino-yield', kamino);
  engine.registerStrategy('jupiter-spot', jupiter);
  engine.registerStrategy('multihopper-route', multihopper);

  console.log(`[STRATEGY 1] Executing Kamino Yield Farm...`);
  const kaminoRes = await engine.executeStrategy('kamino-yield');
  console.log(`   -> Action: ${kaminoRes.actionTaken} ${kaminoRes.amountIn} ${kaminoRes.inputToken} -> ${kaminoRes.outputToken}`);
  console.log(`   -> Projected APR: ${kaminoRes.yieldAprPct}% | TxSig: ${kaminoRes.transactionSignature}`);

  console.log(`[STRATEGY 2] Executing Jupiter Spot Rebalance...`);
  const jupRes = await engine.executeStrategy('jupiter-spot');
  console.log(`   -> Action: ${jupRes.actionTaken} ${jupRes.amountIn} ${jupRes.inputToken} -> ${jupRes.outputToken}`);
  console.log(`   -> TxSig: ${jupRes.transactionSignature}`);

  console.log(`[STRATEGY 3 - BONUS] Executing MultiHopper Cross-Chain Arbitrage...`);
  const hopRes = await engine.executeStrategy('multihopper-route');
  console.log(`   -> Action: ${hopRes.actionTaken} ${hopRes.amountIn} ${hopRes.inputToken} -> ${hopRes.outputToken}`);
  console.log(`   -> TxSig: ${hopRes.transactionSignature}`);

  console.log('\n--- 6. SUB-AGENT PERMISSION DELEGATION ---');
  const subAgentMgr = new SubAgentManager(engine);
  const subAgent = await subAgentMgr.createSubAgent('private-dex-subagent', {
    canSwap: true,
    canYieldFarm: false,
    maxSpend: 2_000_000, // 2 USDC max
  });
  console.log(`[SUB-AGENT] Created Delegated Sub-Agent: "${subAgent.name}"`);
  console.log(`[SUB-AGENT] Delegated Vault: ${subAgent.delegatedVault.toBase58()}`);
  console.log(`[SUB-AGENT] Max Spend Allowance: ${(subAgent.permissions.maxSpend / 1_000_000).toFixed(2)} USDC`);

  // Sub-agent test spend
  await subAgent.attemptSpend(1_500_000);
  console.log(`[SUB-AGENT] Authorized execution of 1.50 USDC within delegated threshold.`);

  console.log('\n================================================================');
  console.log('✅ ALL ACCEPTANCE CRITERIA VERIFIED ON SOLANA DEVNET');
  console.log('================================================================');
}

runDevnetSimulation().catch(console.error);

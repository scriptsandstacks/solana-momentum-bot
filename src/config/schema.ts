import { z } from 'zod';

const chainConfigSchema = z.object({
  enabled: z.boolean(),
  // Path to a wallet/keypair file. Optional and intentionally unused in paper
  // mode; live mode will load this to sign on-chain trades.
  walletFile: z.string().min(1).optional(),
  // Env var name that holds the RPC URL (e.g. SOLANA_RPC_URL). Required for
  // live trading and for on-chain risk signals (mint authority, holder concentration).
  rpcUrlEnv: z.string().min(1).optional(),
  minLiquidityUsd: z.number().positive(),
  minVolume5mUsd: z.number().nonnegative(),
  maxSlippageBps: z.number().int().min(1).max(10_000),
  // Lamports to add as a Solana priority fee per transaction in live mode.
  // 'auto' lets Jupiter set a dynamic fee based on current network congestion.
  // Omit to use no priority fee (not recommended during high congestion periods).
  priorityFeeLamports: z.union([z.number().int().nonnegative(), z.literal('auto')]).optional(),
  // Commitment required before a live swap is treated as confirmed. `confirmed`
  // is faster; `finalized` reduces reorg risk at the cost of extra latency.
  confirmationCommitment: z.enum(['confirmed', 'finalized']).default('confirmed'),
});

const exitRulesSchema = z.object({
  stopLossPct: z.number().positive().max(100),
  // Set high (200-500) for memecoin strategies so the trailing stop — not a
  // fixed ceiling — is the actual exit. A low value (e.g. 50) cuts winners
  // short on assets that routinely move 200-1000%.
  takeProfitPct: z.number().positive(),
  trailingStopPct: z.number().positive().max(100),
  // Minimum unrealized gain (%) before the trailing stop arms.
  // Below this level only the hard stop-loss applies (phase 1).
  // At or above, the trailing stop becomes the downside gate (phase 2).
  trailingArmPct: z.number().nonnegative().max(100).default(0),
  maxHoldMinutes: z.number().int().positive(),
});

const exitRuleOverridesSchema = z.object({
  stopLossPct: z.number().positive().max(100).optional(),
  takeProfitPct: z.number().positive().optional(),
  trailingStopPct: z.number().positive().max(100).optional(),
  trailingArmPct: z.number().nonnegative().max(100).optional(),
  maxHoldMinutes: z.number().int().positive().optional(),
});

const strategyOverridesSchema = z
  .object({
    minScoreToEnter: z.number().min(0).max(100).optional(),
    exits: exitRuleOverridesSchema.optional(),
  })
  .default({});

export const botConfigSchema = z.object({
  mode: z.enum(['paper', 'live']),
  chains: z.object({
    solana: chainConfigSchema,
  }),
  paper: z.object({
    startingBalanceUsd: z.number().positive(),
    positionSizeUsd: z.number().positive(),
    maxOpenPositions: z.number().int().positive(),
    maxDailyLossUsd: z.number().positive(),
  }),
  exits: exitRulesSchema,
  strategies: z
    .object({
      freshLaunchMomentum: strategyOverridesSchema,
      migrationMomentum: strategyOverridesSchema,
    })
    .default({ freshLaunchMomentum: {}, migrationMomentum: {} }),
  // Trading-cost model for paper fills. Defaulted so older configs stay valid;
  // when omitted the bot still applies these realistic defaults rather than
  // frictionless fills.
  fees: z
    .object({
      // Per-leg swap + priority fee assumption, charged on both entry and exit.
      swapFeeBps: z.number().nonnegative().max(10_000),
      // Also charge the candidate's estimated route price impact on each leg.
      applyRouteSlippage: z.boolean(),
    })
    .default({ swapFeeBps: 30, applyRouteSlippage: true }),
  scoring: z.object({
    minimumScoreToEnter: z.number().min(0).max(100),
  }),
  // Data-retention policy. Defaulted so older configs stay valid. Bounds the
  // growth of scored_candidates (the noisy "checked but not traded" rows) while
  // preserving anything tied to a real position. This window doubles as the
  // counterfactual-analysis horizon for the outcomes report.
  retention: z
    .object({
      scoredCandidateDays: z.number().positive(),
    })
    .default({ scoredCandidateDays: 30 }),
  // Controls whether trade open/close/cycle events are formatted as human-readable
  // summary lines during `run` (separate from the raw [run:process] logs).
  // Omitting the section defaults to console=true so the run loop is legible.
  notifications: z
    .object({
      console: z.boolean().default(true),
    })
    .default({ console: true }),
});

export type ChainName = keyof z.infer<typeof botConfigSchema>['chains'];
export type ChainConfig = z.infer<typeof chainConfigSchema>;
export type BotConfig = z.infer<typeof botConfigSchema>;

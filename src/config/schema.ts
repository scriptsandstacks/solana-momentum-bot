import { z } from 'zod';

const chainConfigSchema = z.object({
  enabled: z.boolean(),
  // Path to a wallet/keypair file. Optional and intentionally unused in paper
  // mode; live mode will load this to sign on-chain trades.
  walletFile: z.string().min(1).optional(),
  rpcUrlEnv: z.string().min(1).optional(),
  minLiquidityUsd: z.number().positive(),
  minVolume5mUsd: z.number().nonnegative(),
  maxSlippageBps: z.number().int().min(1).max(10_000),
});

export const botConfigSchema = z.object({
  mode: z.enum(['paper', 'live']),
  chains: z.object({
    solana: chainConfigSchema,
    base: chainConfigSchema,
    ethereum: chainConfigSchema,
  }),
  paper: z.object({
    startingBalanceUsd: z.number().positive(),
    positionSizeUsd: z.number().positive(),
    maxOpenPositions: z.number().int().positive(),
    maxDailyLossUsd: z.number().positive(),
  }),
  exits: z.object({
    stopLossPct: z.number().positive().max(100),
    takeProfitPct: z.number().positive(),
    trailingStopPct: z.number().positive().max(100),
    maxHoldMinutes: z.number().int().positive(),
  }),
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
  // Optional notification transports. Omitting the section disables all push
  // notifications. Telegram and webhook implementations hook into the Reporter
  // interface without changes to bot logic.
  notifications: z
    .object({
      // Set to true to emit trade open/close/cycle events to stdout (default in
      // the run loop; this flag controls whether they are also formatted as
      // structured summaries separate from the raw process logs).
      console: z.boolean().default(true),
      telegram: z
        .object({
          botToken: z.string().min(1),
          chatId: z.string().min(1),
        })
        .optional(),
    })
    .default({ console: true }),
});

export type ChainName = keyof z.infer<typeof botConfigSchema>['chains'];
export type ChainConfig = z.infer<typeof chainConfigSchema>;
export type BotConfig = z.infer<typeof botConfigSchema>;

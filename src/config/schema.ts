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
  mode: z.literal('paper'),
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
  scoring: z.object({
    minimumScoreToEnter: z.number().min(0).max(100),
  }),
});

export type ChainName = keyof z.infer<typeof botConfigSchema>['chains'];
export type ChainConfig = z.infer<typeof chainConfigSchema>;
export type BotConfig = z.infer<typeof botConfigSchema>;

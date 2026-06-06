// Creates real production LiveBrokerDeps: loads a Solana keypair, builds
// RPC helpers, and wires up the Jupiter swap API. All I/O is async and the
// deps object is injected into LiveBroker so unit tests can supply fakes.

import fs from 'node:fs';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import type { LiveBrokerDeps } from './liveBroker.js';
import { getJupiterQuoteForSwap, getJupiterSwapTransaction } from './jupiterSwap.js';
import { parseConfirmedSwapFill, type ParsedSolanaTransaction } from './solanaTransactionFill.js';
import { confirmSolanaTransaction } from './solanaConfirmation.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD';
const SOL_DECIMALS = 9;
const USDC_DECIMALS = 6;
const USDT_DECIMALS = 6;

export interface LiveDepsConfig {
  rpcUrl: string;
  maxSlippageBps: number;
  confirmationCommitment?: 'confirmed' | 'finalized';
  // lamports charged per transaction for prioritisation. 'auto' lets Jupiter
  // set a dynamic fee; omit to use no prioritisation fee.
  priorityFeeLamports?: number | 'auto';
}

export interface WalletCashInventory {
  publicKey: string;
  solLamports: bigint;
  sol: number;
  solUsd: number;
  solPriceUsd: number;
  usdc: number;
  usdt: number;
  totalUsd: number;
}

// Load a Solana CLI-format keypair (64-element integer JSON array).
export function loadSolanaKeypair(walletFile: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(walletFile, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// Query the wallet's supported route-input inventory and value it in USD.
export async function queryWalletCashUsd(
  publicKey: string,
  deps: Pick<LiveBrokerDeps, 'getSolPriceUsd'>,
  rpcRequest: (method: string, params: unknown[]) => Promise<unknown>,
): Promise<number> {
  return (await queryWalletCashInventory(publicKey, deps, rpcRequest)).totalUsd;
}

// Query supported route-input balances separately so operators can verify that
// live trading has SOL for fees and stablecoin/SOL inventory for entries.
export async function queryWalletCashInventory(
  publicKey: string,
  deps: Pick<LiveBrokerDeps, 'getSolPriceUsd'>,
  rpcRequest: (method: string, params: unknown[]) => Promise<unknown>,
): Promise<WalletCashInventory> {
  const balance = (await rpcRequest('getBalance', [publicKey])) as { value?: number };
  const solLamports = BigInt(balance.value ?? 0);
  const sol = Number(solLamports) / 10 ** SOL_DECIMALS;
  const solPriceUsd = await deps.getSolPriceUsd();
  const usdc = Number(await querySplTokenBalance(publicKey, USDC_MINT, rpcRequest)) / 10 ** USDC_DECIMALS;
  const usdt = Number(await querySplTokenBalance(publicKey, USDT_MINT, rpcRequest)) / 10 ** USDT_DECIMALS;
  const solUsd = sol * solPriceUsd;
  return {
    publicKey,
    solLamports,
    sol,
    solUsd,
    solPriceUsd,
    usdc,
    usdt,
    totalUsd: solUsd + usdc + usdt,
  };
}

export function createLiveBrokerDeps(keypair: Keypair, config: LiveDepsConfig): LiveBrokerDeps {
  const { rpcUrl, maxSlippageBps } = config;

  const rpcRequest = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Solana RPC ${method} failed: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`Solana RPC ${method}: ${json.error.message}`);
    return json.result;
  };

  const decimalsCache = new Map<string, number>();
  const publicKey = keypair.publicKey.toBase58();

  const getTokenDecimals = async (mint: string): Promise<number> => {
    if (mint === SOL_MINT) return SOL_DECIMALS;
    if (mint === USDC_MINT) return USDC_DECIMALS;
    const hit = decimalsCache.get(mint);
    if (hit !== undefined) return hit;
    const result = await rpcRequest('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const info = result as { value?: { data?: { parsed?: { info?: { decimals?: number } } } } | null };
    const d = info?.value?.data?.parsed?.info?.decimals;
    if (typeof d !== 'number') throw new Error(`Cannot determine decimals for mint ${mint}`);
    decimalsCache.set(mint, d);
    return d;
  };

  const getSolPriceUsd = async (): Promise<number> => {
    const quote = await getJupiterQuoteForSwap({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: 1_000_000_000, // 1 SOL in lamports
      slippageBps: 100,
    });
    if (!quote) throw new Error('Cannot fetch SOL/USD price from Jupiter');
    return Number(quote.outAmount) / 1e6;
  };

  return {
    getPublicKey: () => publicKey,

    getSolPriceUsd,

    getTokenDecimals,

    async getWalletBalance(mint) {
      if (mint === SOL_MINT) {
        const result = await rpcRequest('getBalance', [publicKey]) as { value?: number };
        return BigInt(result.value ?? 0);
      }
      return querySplTokenBalance(publicKey, mint, rpcRequest);
    },

    async getJupiterQuote(params) {
      return getJupiterQuoteForSwap({
        ...params,
        slippageBps: params.slippageBps ?? maxSlippageBps,
      });
    },

    async getSwapTransaction(params) {
      const tx = await getJupiterSwapTransaction({
        quoteResponse: params.quoteResponse,
        userPublicKey: params.userPublicKey,
        wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
        prioritizationFeeLamports: config.priorityFeeLamports,
      });
      if (!tx) throw new Error('Jupiter swap endpoint did not return a transaction');
      return tx;
    },

    async signAndSendTransaction(transactionBase64) {
      const txBytes = Buffer.from(transactionBase64, 'base64');
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([keypair]);
      const serialized = Buffer.from(tx.serialize()).toString('base64');
      const signature = await rpcRequest('sendTransaction', [
        serialized,
        { encoding: 'base64', skipPreflight: false, maxRetries: 3 },
      ]);
      return signature as string;
    },

    async confirmTransaction(signature, lastValidBlockHeight) {
      await confirmSolanaTransaction({
        signature,
        lastValidBlockHeight,
        commitment: config.confirmationCommitment,
        rpcRequest,
      });
    },

    async getConfirmedSwapFill(params) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const result = await rpcRequest('getTransaction', [
          params.signature,
          {
            commitment: config.confirmationCommitment ?? 'confirmed',
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
          },
        ]);
        if (result) {
          return parseConfirmedSwapFill(result as ParsedSolanaTransaction, params);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
      throw new Error(`Confirmed transaction ${params.signature} was not available for fill accounting within 15 seconds`);
    },
  };
}

async function querySplTokenBalance(
  publicKey: string,
  mint: string,
  rpcRequest: (method: string, params: unknown[]) => Promise<unknown>,
): Promise<bigint> {
  const result = await rpcRequest('getTokenAccountsByOwner', [
    publicKey,
    { mint },
    { encoding: 'jsonParsed' },
  ]) as {
    value?: Array<{
      account?: {
        data?: {
          parsed?: {
            info?: {
              tokenAmount?: { amount?: string };
            };
          };
        };
      };
    }>;
  };

  let total = 0n;
  for (const row of result.value ?? []) {
    const amount = row.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amount !== undefined) total += BigInt(amount);
  }
  return total;
}

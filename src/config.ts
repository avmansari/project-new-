import "dotenv/config";
import { z } from "zod";
import { isAddressForNetwork } from "./zcash/address.js";

const envSchema = z.object({
  NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
  CONFIRM_MAINNET: z.string().default("no"),
  WALLET_XPUB: z.string().min(1, "WALLET_XPUB is required (run: npm run wallet:new)"),
  DB_DIR: z.string().default("./data/db"),
  ORDER_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  MIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(1000).default(10),
  LATE_GRACE_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(168),
  TREASURY_ADDRESS: z.string().optional(),
  MIN_PAYOUT_ZATS: z.coerce.number().int().min(1000).default(1_000_000),
  REPORT_FREEZE_MIN: z.coerce.number().int().min(1).default(3),
  REPORT_FREEZE_PCT: z.coerce.number().int().min(1).max(100).default(10),
  MIN_REFUND_NET_ZATS: z.coerce.number().int().min(1000).default(10000),
  FEE_MARGINAL_ZATS: z.coerce.number().int().min(1).default(5000),
  FEE_GRACE_ACTIONS: z.coerce.number().int().min(1).default(2),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(120),
  ORDER_RATE_PER_MIN: z.coerce.number().int().min(1).default(5),
  ORDER_RATE_PER_HOUR: z.coerce.number().int().min(1).default(40),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(10_000),
  MARKETPLACE_FEE_BPS: z.coerce.number().int().min(0).max(10000).default(250),
  VERIFIED_VOLUME_ZATS: z.coerce.number().min(1).default(2_000_000_000),
  ZEC_USD_RATE: z.coerce.number().min(0).optional(),
  ZEC_INR_RATE: z.coerce.number().min(0).optional(),
  UPLOAD_RATE_PER_MIN: z.coerce.number().int().min(1).default(6000),
  MAX_FILE_BYTES: z.coerce.number().int().min(1).default(10 * 1024 * 1024),
  MAX_SESSION_BYTES: z.coerce.number().int().min(1).default(20 * 1024 * 1024 * 1024),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  ADMIN_SESSION_HOURS: z.coerce.number().int().min(1).default(24),
  ASSETS_DIR: z.string().default("./data/assets"),
  IMAGE_RATE_PER_MIN: z.coerce.number().int().min(1).default(600),
  REFUND_EXPIRY_MARGIN: z.coerce.number().int().min(10).max(10_000).default(100),
  REFUND_STUCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  CHAIN_BACKEND: z.enum(["file", "lightwalletd"]).default("file"),
  LWD_URL: z.string().optional(),
  LWD_LOOKBACK_BLOCKS: z.coerce.number().int().min(10).max(1_000_000).default(30_000),
  LWD_VERIFY_TXIDS: z.enum(["unverified", "all", "off"]).default("unverified"),
  LWD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  FAKE_CHAIN_FILE: z.string().default("./data/fake-chain.json"),
});

export type Network = "mainnet" | "testnet";

export interface AppConfig {
  network: Network;
  walletXpub: string;
  dbDir: string;
  orderTtlMinutes: number;
  minConfirmations: number;
  lateGraceHours: number;
  treasuryAddress?: string;
  minPayoutZats: bigint;
  reportFreezeMin: number;
  reportFreezePct: number;
  minRefundNetZats: bigint;
  feeMarginalZats: bigint;
  feeGraceActions: number;
  port: number;
  host: string;
  rateLimitPerMin: number;
  orderRatePerMin: number;
  orderRatePerHour: number;
  workerIntervalMs: number;
  marketplaceFeeBps: number;
  verifiedVolumeZats: bigint;
  zecUsdRate?: number;
  zecInrRate?: number;
  uploadRatePerMin: number;
  maxFileBytes: number;
  maxSessionBytes: number;
  adminPasswordHash?: string;
  adminSessionHours: number;
  assetsDir: string;
  imageRatePerMin: number;
  refundExpiryMargin: number;
  refundStuckMinutes: number;
  chainBackend: "file" | "lightwalletd";
  lwdUrl?: string;
  lwdLookbackBlocks: number;
  lwdTimeoutMs: number;
  lwdVerifyTxids: "unverified" | "all" | "off";
  fakeChainFile: string;
}

/**
 * Env validate karta hai. Mainnet pe jaane ke liye CONFIRM_MAINNET=yes zaroori hai,
 * taaki galti se real paise wale mode mein server na chal jaye.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${msg}`);
  }
  const e = parsed.data;
  const { NETWORK, CONFIRM_MAINNET, WALLET_XPUB, DB_DIR, ORDER_TTL_MINUTES } = e;

  if (NETWORK === "mainnet" && CONFIRM_MAINNET !== "yes") {
    throw new Error(
      "NETWORK=mainnet hai lekin CONFIRM_MAINNET=yes set nahi hai. " +
        "Ye real ZEC wala mode hai, isliye explicit confirmation chahiye."
    );
  }
  const treasury = e.TREASURY_ADDRESS?.trim() || undefined;
  if (treasury && !isAddressForNetwork(treasury, NETWORK)) {
    throw new Error(`TREASURY_ADDRESS ${NETWORK} ka valid t-address nahi hai`);
  }
  return {
    network: NETWORK,
    walletXpub: WALLET_XPUB,
    dbDir: DB_DIR,
    orderTtlMinutes: ORDER_TTL_MINUTES,
    minConfirmations: e.MIN_CONFIRMATIONS,
    lateGraceHours: e.LATE_GRACE_HOURS,
    treasuryAddress: treasury,
    minPayoutZats: BigInt(e.MIN_PAYOUT_ZATS),
    reportFreezeMin: e.REPORT_FREEZE_MIN,
    reportFreezePct: e.REPORT_FREEZE_PCT,
    minRefundNetZats: BigInt(e.MIN_REFUND_NET_ZATS),
    feeMarginalZats: BigInt(e.FEE_MARGINAL_ZATS),
    feeGraceActions: e.FEE_GRACE_ACTIONS,
    port: e.PORT,
    host: e.HOST,
    rateLimitPerMin: e.RATE_LIMIT_PER_MIN,
    orderRatePerMin: e.ORDER_RATE_PER_MIN,
    orderRatePerHour: e.ORDER_RATE_PER_HOUR,
    workerIntervalMs: e.WORKER_INTERVAL_MS,
    marketplaceFeeBps: e.MARKETPLACE_FEE_BPS,
    verifiedVolumeZats: BigInt(Math.round(e.VERIFIED_VOLUME_ZATS)),
    zecUsdRate: e.ZEC_USD_RATE,
    zecInrRate: e.ZEC_INR_RATE,
    uploadRatePerMin: e.UPLOAD_RATE_PER_MIN,
    maxFileBytes: e.MAX_FILE_BYTES,
    maxSessionBytes: e.MAX_SESSION_BYTES,
    adminPasswordHash: e.ADMIN_PASSWORD_HASH?.trim() || undefined,
    adminSessionHours: e.ADMIN_SESSION_HOURS,
    assetsDir: e.ASSETS_DIR,
    imageRatePerMin: e.IMAGE_RATE_PER_MIN,
    refundExpiryMargin: e.REFUND_EXPIRY_MARGIN,
    refundStuckMinutes: e.REFUND_STUCK_MINUTES,
    chainBackend: e.CHAIN_BACKEND,
    lwdUrl: e.LWD_URL?.trim() || undefined,
    lwdLookbackBlocks: e.LWD_LOOKBACK_BLOCKS,
    lwdTimeoutMs: e.LWD_TIMEOUT_MS,
    lwdVerifyTxids: e.LWD_VERIFY_TXIDS,
    fakeChainFile: e.FAKE_CHAIN_FILE,
  };
}


export interface SignerConfig {
  network: Network;
  treasuryAddress?: string;
  maxFeeZats: bigint;
  /** Optional: agar set ho to mnemonic isse match karna zaroori hai (galat mnemonic pakadne ke liye) */
  walletXpub?: string;
}

/**
 * Offline signer ki chhoti config: DB ya server settings ki zaroorat nahi.
 * Mainnet pe: CONFIRM_MAINNET=yes, TREASURY_ADDRESS aur WALLET_XPUB dono zaroori.
 */
export function loadSignerConfig(env: NodeJS.ProcessEnv = process.env): SignerConfig {
  const parsed = z
    .object({
      NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
      CONFIRM_MAINNET: z.string().default("no"),
      TREASURY_ADDRESS: z.string().optional(),
      WALLET_XPUB: z.string().optional(),
      MAX_FEE_ZATS: z.coerce.number().int().min(1).default(100_000),
    })
    .parse(env);
  if (parsed.NETWORK === "mainnet" && parsed.CONFIRM_MAINNET !== "yes") {
    throw new Error("NETWORK=mainnet hai lekin CONFIRM_MAINNET=yes set nahi hai.");
  }
  const treasury = parsed.TREASURY_ADDRESS?.trim() || undefined;
  if (treasury && !isAddressForNetwork(treasury, parsed.NETWORK)) {
    throw new Error(`TREASURY_ADDRESS ${parsed.NETWORK} ka valid t-address nahi hai`);
  }
  const xpub = parsed.WALLET_XPUB?.trim() || undefined;
  if (parsed.NETWORK === "mainnet" && (!treasury || !xpub)) {
    throw new Error("Mainnet signing ke liye TREASURY_ADDRESS aur WALLET_XPUB dono set hone chahiye.");
  }
  return { network: parsed.NETWORK, treasuryAddress: treasury, maxFeeZats: BigInt(parsed.MAX_FEE_ZATS), walletXpub: xpub };
}

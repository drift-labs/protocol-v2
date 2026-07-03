/**
 * Oracle types and the OraclePriceData interface used throughout the SDK.
 * Each oracle source (Pyth, Switchboard, Pyth Lazer, Prelaunch) has a client adapter
 * in this directory that fetches and normalises prices into OraclePriceData.
 * Oracle client selection is configured via VelocityClientConfig and cached in OracleClientCache.
 */
import { BN } from '../isomorphic/anchor';
import { PublicKey } from '@solana/web3.js';
import { OracleSource } from '../types';

/**
 * `OraclePriceData` variant for the market-maker (MM) oracle feed, which has no TWAP or
 * pre-launch `maxPrice` fields but instead flags whether the MM oracle is currently trusted.
 */
export type MMOraclePriceData = Omit<
	OraclePriceData,
	'twap' | 'twapConfidence' | 'maxPrice'
> & {
	/** Whether the MM oracle is currently considered active/valid and safe to use in place of the primary oracle. */
	isMMOracleActive: boolean;
	/**
	 * Whether the MM oracle is enabled (has a non-zero price), mirroring `MMOraclePriceData::is_enabled`.
	 * Populated by `VelocityClient.getMMOracleDataForPerpMarket`; used by the AMM-fill volatility gate
	 * (`isFallbackAvailableLiquiditySource`). Optional because MM data is sometimes constructed without it.
	 */
	isMMOracleEnabled?: boolean;
	/**
	 * Whether the MM oracle is at least as recent as the exchange (safe) oracle, mirroring
	 * `MMOraclePriceData::is_mm_oracle_as_recent`. Used together with `isMMExchangeDiffBpsHigh` by the
	 * AMM-fill volatility gate.
	 */
	isMMOracleAsRecent?: boolean;
	/**
	 * Whether the MM-vs-exchange oracle price difference exceeds the 1% fallback threshold
	 * (`MM_EXCHANGE_FALLBACK_THRESHOLD`), mirroring `MMOraclePriceData::is_mm_exchange_diff_bps_high`.
	 * When the MM oracle is enabled and as-recent, a high diff suppresses AMM fills (early volatility protection).
	 */
	isMMExchangeDiffBpsHigh?: boolean;
};

/** Normalized oracle price snapshot produced by every `OracleClient`, regardless of underlying source. */
export type OraclePriceData = {
	/** Oracle price, PRICE_PRECISION (1e6). */
	price: BN;
	/** Slot at which this price was last updated on-chain. */
	slot: BN;
	/** Oracle confidence interval (± band around `price`), PRICE_PRECISION (1e6). */
	confidence: BN;
	/** Whether the source had enough independent publishers/quoters for the price to be trusted (Pyth-specific; always `true` for sources without a publisher-count concept). */
	hasSufficientNumberOfDataPoints: boolean;
	/** Time-weighted average price, PRICE_PRECISION (1e6). Absent for sources with no TWAP (e.g. Pyth Lazer echoes the live price here instead). */
	twap?: BN;
	/** Confidence interval of `twap`, PRICE_PRECISION (1e6). */
	twapConfidence?: BN;
	/** Upper price bound; only populated for prelaunch-market oracles, PRICE_PRECISION (1e6). */
	maxPrice?: BN; // pre-launch markets only
	/** Monotonic sequence/publish-time id used to detect out-of-order updates (Pyth Lazer only). */
	sequenceId?: BN;
};

/** Identifies an oracle account and which `OracleSource` variant to decode it as. */
export type OracleInfo = {
	publicKey: PublicKey;
	source: OracleSource;
};

/** Common interface implemented by every per-source oracle adapter (Pyth, Pyth Lazer, prelaunch, quote-asset). */
export interface OracleClient {
	/**
	 * Decodes raw oracle account bytes into normalized `OraclePriceData` without any RPC call.
	 * @param buffer - Raw account data as returned by `getAccountInfo`/`getMultipleAccounts`.
	 * @returns The decoded, normalized price data.
	 */
	getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData;
	/**
	 * Fetches and decodes an oracle account's current price data.
	 * @param publicKey - The oracle account's address.
	 * @returns The decoded, normalized price data.
	 * @throws Error if the account does not exist.
	 */
	getOraclePriceData(publicKey: PublicKey): Promise<OraclePriceData>;
}

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import { AnchorProvider, BN, Program } from '../isomorphic/anchor';
import { Velocity } from '../idl/velocity';
import { VelocityProgram } from '../config';
import {
	ONE,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	TEN,
} from '../constants/numericConstants';
import { Wallet } from '../wallet';
import velocityIDL from '../idl/velocity.json';
import { getOracleAccountDataOrThrow } from './utils';

/**
 * `OracleClient` for `PythLazerOracle` accounts — Velocity's on-chain cache of a Pyth Lazer
 * push-update feed, decoded via the velocity program's own Anchor coder (Lazer has no dedicated
 * client account layout package, unlike legacy Pyth). Backs the `pythLazer`, `pythLazer1K`,
 * `pythLazer1M`, and `pythLazerStableCoin` `OracleSource` variants.
 */
export class PythLazerClient implements OracleClient {
	private connection: Connection;
	private multiple: BN;
	private stableCoin: boolean;
	private program: VelocityProgram;
	readonly decodeFunc: (name: string, data: Buffer) => any;

	/**
	 * @param connection - RPC connection used to fetch oracle account data; also used to spin up a
	 * throwaway `AnchorProvider`/`Program` (with a fresh random keypair, never used to sign) purely
	 * to get access to the IDL's `pythLazerOracle` account coder.
	 * @param multiple - Divisor applied to the raw Lazer precision before rescaling to
	 * PRICE_PRECISION; pass `1000`/`1000000` for the `pythLazer1K`/`pythLazer1M` source variants, or
	 * the default `ONE` (1) for a standard per-unit feed.
	 * @param stableCoin - When `true` (the `pythLazerStableCoin` variant), snaps the decoded price
	 * to exactly `QUOTE_PRECISION` (1.0) whenever it is within 5bps (or within `confidence` if
	 * tighter) of peg — see `getStableCoinPrice`.
	 */
	public constructor(
		connection: Connection,
		multiple = ONE,
		stableCoin = false
	) {
		this.connection = connection;
		this.multiple = multiple;
		this.stableCoin = stableCoin;
		const provider = new AnchorProvider(
			this.connection,
			//@ts-ignore
			new Wallet(new Keypair()),
			{
				commitment: connection.commitment,
			}
		);
		this.program = new Program<Velocity>(velocityIDL as Velocity, provider);
		this.decodeFunc = (
			this.program.account as any
		).pythLazerOracle.coder.accounts.decodeUnchecked.bind(
			(this.program.account as any).pythLazerOracle.coder.accounts
		);
	}

	/**
	 * Fetches and decodes a `PythLazerOracle` account's current price data.
	 * @param pricePublicKey - The `PythLazerOracle` account's address (see `getPythLazerOraclePublicKey`).
	 * @returns The decoded, normalized price data.
	 * @throws Error if the account does not exist.
	 */
	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const data = await getOracleAccountDataOrThrow(
			this.connection,
			pricePublicKey,
			'Pyth lazer oracle'
		);
		return this.getOraclePriceDataFromBuffer(data);
	}

	/**
	 * Decodes raw `PythLazerOracle` account bytes into normalized `OraclePriceData`, rescaling from
	 * the feed's native exponent to PRICE_PRECISION (1e6) via `convertPythPrice`. Unlike legacy
	 * Pyth, Lazer has no separate TWAP field on-chain, so `twap`/`twapConfidence` are both set to
	 * the same converted live `price`/`conf` rather than a genuine time-weighted average.
	 * `hasSufficientNumberOfDataPoints` is always `true` (no publisher-count concept for this
	 * source), and `sequenceId` is set to the feed's `publishTime` for staleness/ordering checks.
	 * @param buffer - Raw `PythLazerOracle` account data.
	 * @returns `price`, `confidence`, `twap`, `twapConfidence` (all PRICE_PRECISION 1e6), `slot`
	 * (`postedSlot`, the slot the update landed on-chain), and `sequenceId` (`publishTime`).
	 */
	public getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData {
		const priceData = this.decodeFunc('pythLazerOracle', buffer);
		const confidence = convertPythPrice(
			priceData.conf,
			priceData.exponent,
			this.multiple
		);
		let price = convertPythPrice(
			priceData.price,
			priceData.exponent,
			this.multiple
		);
		if (this.stableCoin) {
			price = getStableCoinPrice(price, confidence);
		}

		return {
			price,
			slot: priceData.postedSlot,
			confidence,
			twap: convertPythPrice(
				priceData.price,
				priceData.exponent,
				this.multiple
			),
			twapConfidence: convertPythPrice(
				priceData.price,
				priceData.exponent,
				this.multiple
			),
			hasSufficientNumberOfDataPoints: true,
			sequenceId: priceData.publishTime,
		};
	}
}

function convertPythPrice(price: BN, exponent: number, multiple: BN): BN {
	exponent = Math.abs(exponent);
	const pythPrecision = TEN.pow(new BN(exponent).abs()).div(multiple);
	return price.mul(PRICE_PRECISION).div(pythPrecision);
}

const fiveBPS = new BN(500);
function getStableCoinPrice(price: BN, confidence: BN): BN {
	if (price.sub(QUOTE_PRECISION).abs().lte(BN.min(confidence, fiveBPS))) {
		return QUOTE_PRECISION;
	} else {
		return price;
	}
}

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { OracleClient, OraclePriceData } from './types';
import { AnchorProvider, BN, Idl, Program } from '@coral-xyz/anchor';
import {
	ONE,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	TEN,
} from '../constants/numericConstants';
import { DRIFT_PROGRAM_ID, Wallet } from '..';
import driftIDL from '../idl/drift.json';

export class PythLazerClient implements OracleClient {
	private connection: Connection;
	private multiple: BN;
	private stableCoin: boolean;
	private program: Program;
	readonly decodeFunc: (name: string, data: Buffer) => any;

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
		this.program = new Program(
			driftIDL as Idl,
			new PublicKey(DRIFT_PROGRAM_ID),
			provider
		);
		this.decodeFunc =
			this.program.account.pythLazerOracle.coder.accounts.decodeUnchecked.bind(
				this.program.account.pythLazerOracle.coder.accounts
			);
	}

	public async getOraclePriceData(
		pricePublicKey: PublicKey
	): Promise<OraclePriceData> {
		const accountInfo = await this.connection.getAccountInfo(pricePublicKey);
		return this.getOraclePriceDataFromBuffer(accountInfo.data);
	}

	public getOraclePriceDataFromBuffer(buffer: Buffer): OraclePriceData {
		const priceData = this.decodeFunc('PythLazerOracle', buffer);
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
	if (price.sub(QUOTE_PRECISION).abs().lt(BN.min(confidence, fiveBPS))) {
		return QUOTE_PRECISION;
	} else {
		return price;
	}
}

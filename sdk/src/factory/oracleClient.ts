import { isVariant, OracleSource } from '../types';
import { Connection } from '@solana/web3.js';
import { OracleClient } from '../oracles/types';
import { PythClient } from '../oracles/pythClient';
// import { SwitchboardClient } from '../oracles/switchboardClient';
import { QuoteAssetOracleClient } from '../oracles/quoteAssetOracleClient';

export function getOracleClient(
	oracleSource: OracleSource,
	connection: Connection
): OracleClient {
	if (isVariant(oracleSource, 'pyth')) {
		return new PythClient(connection);
	}

	// if (isVariant(oracleSource, 'switchboard')) {
	// 	return new SwitchboardClient(connection);
	// }

	if (isVariant(oracleSource, 'quoteAsset')) {
		return new QuoteAssetOracleClient();
	}

	throw new Error(`Unknown oracle source ${oracleSource}`);
}

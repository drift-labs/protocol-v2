import { isVariant, OracleSource } from '../types';
import { Connection } from '@solana/web3.js';
import { OracleClient } from '../oracles/types';
import { PythClient } from '../oracles/pythClient';
// import { SwitchboardClient } from '../oracles/switchboardClient';
import { QuoteAssetOracleClient } from '../oracles/quoteAssetOracleClient';
import { BN, Program } from '@coral-xyz/anchor';
import { PrelaunchOracleClient } from '../oracles/prelaunchOracleClient';
import { SwitchboardClient } from '../oracles/switchboardClient';
import { PythPullClient } from '../oracles/pythPullClient';
import { SwitchboardOnDemandClient } from '../oracles/switchboardOnDemandClient';
import { PythLazerClient } from '../oracles/pythLazerClient';

export function getOracleClient(
	oracleSource: OracleSource,
	connection: Connection,
	program: Program
): OracleClient {
	if (isVariant(oracleSource, 'pyth')) {
		return new PythClient(connection);
	}

	if (isVariant(oracleSource, 'pythPull')) {
		return new PythPullClient(connection);
	}

	if (isVariant(oracleSource, 'pyth1K')) {
		return new PythClient(connection, new BN(1000));
	}

	if (isVariant(oracleSource, 'pyth1KPull')) {
		return new PythPullClient(connection, new BN(1000));
	}

	if (isVariant(oracleSource, 'pyth1M')) {
		return new PythClient(connection, new BN(1000000));
	}

	if (isVariant(oracleSource, 'pyth1MPull')) {
		return new PythPullClient(connection, new BN(1000000));
	}

	if (isVariant(oracleSource, 'pythStableCoin')) {
		return new PythClient(connection, undefined, true);
	}

	if (isVariant(oracleSource, 'pythStableCoinPull')) {
		return new PythPullClient(connection, undefined, true);
	}

	if (isVariant(oracleSource, 'switchboard')) {
		return new SwitchboardClient(connection);
	}

	if (isVariant(oracleSource, 'prelaunch')) {
		return new PrelaunchOracleClient(connection, program);
	}

	if (isVariant(oracleSource, 'quoteAsset')) {
		return new QuoteAssetOracleClient();
	}

	if (isVariant(oracleSource, 'switchboardOnDemand')) {
		return new SwitchboardOnDemandClient(connection);
	}

	if (isVariant(oracleSource, 'pythLazer')) {
		return new PythLazerClient(connection);
	}

	if (isVariant(oracleSource, 'pythLazer1K')) {
		return new PythLazerClient(connection, new BN(1000));
	}

	if (isVariant(oracleSource, 'pythLazer1M')) {
		return new PythLazerClient(connection, new BN(1000000));
	}

	if (isVariant(oracleSource, 'pythLazerStableCoin')) {
		return new PythLazerClient(connection, undefined, true);
	}

	throw new Error(`Unknown oracle source ${oracleSource}`);
}

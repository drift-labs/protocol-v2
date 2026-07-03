import { isVariant, OracleSource } from '../types';
import { Connection } from '@solana/web3.js';
import { OracleClient } from '../oracles/types';
import { PythClient } from '../oracles/pythClient';
import { QuoteAssetOracleClient } from '../oracles/quoteAssetOracleClient';
import { BN } from '../isomorphic/anchor';
import { VelocityProgram } from '../config';
import { PrelaunchOracleClient } from '../oracles/prelaunchOracleClient';
import { PythLazerClient } from '../oracles/pythLazerClient';

export function getOracleClient(
	oracleSource: OracleSource,
	connection: Connection,
	program: VelocityProgram
): OracleClient {
	if (isVariant(oracleSource, 'pyth')) {
		return new PythClient(connection);
	}

	if (isVariant(oracleSource, 'pyth1K')) {
		return new PythClient(connection, new BN(1000));
	}

	if (isVariant(oracleSource, 'pyth1M')) {
		return new PythClient(connection, new BN(1000000));
	}

	if (isVariant(oracleSource, 'pythStableCoin')) {
		return new PythClient(connection, undefined, true);
	}

	if (isVariant(oracleSource, 'prelaunch')) {
		return new PrelaunchOracleClient(connection, program);
	}

	if (isVariant(oracleSource, 'quoteAsset')) {
		return new QuoteAssetOracleClient();
	}

	if (
		isVariant(oracleSource, 'pythPull') ||
		isVariant(oracleSource, 'pyth1KPull') ||
		isVariant(oracleSource, 'pyth1MPull') ||
		isVariant(oracleSource, 'pythStableCoinPull')
	) {
		throw new Error('Pyth pull oracle support has been removed from the SDK');
	}

	if (
		isVariant(oracleSource, 'deprecatedSwitchboard') ||
		isVariant(oracleSource, 'deprecatedSwitchboardOnDemand')
	) {
		throw new Error('Switchboard oracle support has been removed from the SDK');
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

import { isVariant, OracleSource } from '../types';
import { Connection } from '@solana/web3.js';
import { DriftEnv } from '../config';
import { OracleClient } from '../oracles/types';
import { PythClient } from '../oracles/pythClient';
import { SwitchboardClient } from '../oracles/switchboardClient';

export function getOracleClient(
	oracleSource: OracleSource,
	connection: Connection,
	env: DriftEnv
): OracleClient {
	if (isVariant(oracleSource, 'pyth')) {
		return new PythClient(connection);
	}

	if (isVariant(oracleSource, 'switchboard')) {
		return new SwitchboardClient(connection, env);
	}

	throw new Error(`Unknown oracle source ${oracleSource}`);
}

import { OracleClient } from './types';
import { OracleSource } from '../types';
import { getOracleClient } from '../factory/oracleClient';
import { Connection } from '@solana/web3.js';
import { VelocityProgram } from '../config';

/**
 * Caches one `OracleClient` instance per oracle *source kind* (not per account), so repeated
 * lookups for the same `OracleSource` variant (e.g. every `pyth1KPull` market) reuse a single
 * adapter instead of constructing a new one each time.
 */
export class OracleClientCache {
	cache = new Map<string, OracleClient>();
	public constructor() {}

	/**
	 * Returns the cached `OracleClient` for `oracleSource`'s variant key, constructing and caching
	 * one via `getOracleClient` on first use.
	 * @param oracleSource - Oracle source variant (its top-level key, e.g. `"pyth"`, is the cache key —
	 * note this means all sources sharing a variant name share one client instance regardless of any
	 * other fields on the variant).
	 * @param connection - RPC connection passed through to the client on construction.
	 * @param program - Velocity Anchor program, used by clients that decode via the program's IDL coder.
	 * @returns The `OracleClient` for this source variant.
	 * @throws Error (via `getOracleClient`) if `oracleSource` is not a recognized variant.
	 */
	public get(
		oracleSource: OracleSource,
		connection: Connection,
		program: VelocityProgram
	) {
		const key = Object.keys(oracleSource)[0];
		if (this.cache.has(key)) {
			return this.cache.get(key);
		}

		const client = getOracleClient(oracleSource, connection, program);
		this.cache.set(key, client);
		return client;
	}
}

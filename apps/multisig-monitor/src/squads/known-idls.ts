/**
 * Registry of bundled IDLs for known programs.
 *
 * The cpi-decoder consults this map to decode Anchor instruction args inside
 * a multisig's vault_transaction_create / _execute. Bundling IDLs eliminates
 * RPC calls per program, removes cold-start latency, and works even if the
 * on-chain IDL hasn't been republished after a program upgrade.
 *
 * If the multisig CPIs into a program that isn't in this map, the alert
 * still surfaces program ID + accounts (layer 1) — just without decoded
 * arg names/values. Add new IDLs here when they're imported as a dep.
 */
import type { Idl } from '@coral-xyz/anchor';
import { IDL as velocityVaultsIdl, VAULT_PROGRAM_ID } from '@velocity-exchange/vaults-sdk';
import velocityIdl from '@velocity-exchange/sdk/lib/node/idl/velocity.json';
import { logInfo } from '../log';

// Source of truth is the IDL's own `address` field, not @velocity-exchange/sdk's
// exported program-ID constant. The bundled IDL points at the active `vELoC...`
// program; keying the registry by a stale constant would mean the decoder
// never resolves CPIs into the active program.
export const VELOCITY_PROGRAM_ID = velocityIdl.address;

export const VELOCITY_VAULTS_PROGRAM_ID = VAULT_PROGRAM_ID.toBase58();

const REGISTRY: ReadonlyMap<string, Idl> = (() => {
	const map = new Map<string, Idl>();
	map.set(VELOCITY_PROGRAM_ID, velocityIdl as Idl);
	map.set(VELOCITY_VAULTS_PROGRAM_ID, velocityVaultsIdl as Idl);
	logInfo('known idls loaded', { count: map.size });
	return map;
})();

export function getKnownIdls(): Promise<ReadonlyMap<string, Idl>> {
	return Promise.resolve(REGISTRY);
}

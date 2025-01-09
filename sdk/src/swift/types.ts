import { Buffer } from 'buffer';

/**
 * Represents proof of a swift taker order
 * It can be provided to drift program to fill a swift order
 */
export interface SignedSwiftOrderParams {
	/**
	 * The encoded order params that were signed (borsh encoded then hexified).
	 */
	orderParams: Buffer;
	/**
	 * The signature generated for the orderParams
	 */
	signature: Buffer;
}

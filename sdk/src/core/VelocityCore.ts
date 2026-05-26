import type {
	AccountMeta,
	Connection,
	PublicKey,
	TransactionInstruction,
} from '@solana/web3.js';

import * as pdas from '../addresses/pda';
import * as constants from '../constants';
import { decodeUser } from '../decode/user';
import { CustomBorshCoder } from '../decode/customCoder';
import driftIDL from '../idl/drift.json';
import type { Drift } from '../idl/drift';
import type { UserAccount } from '../types';
import type { VelocityProgram } from '../config';
import { fetchAccount } from '../accounts/fetch';
import type { BN } from '@coral-xyz/anchor';
import { buildDepositInstruction } from './instructions/deposit';
import { buildWithdrawInstruction } from './instructions/withdraw';
import {
	buildCancelOrdersInstruction,
	buildPlaceOrdersInstruction,
} from './instructions/orders';
import { buildFillPerpOrderInstruction } from './instructions/fill';
import { buildTriggerOrderInstruction } from './instructions/trigger';
import { buildSettlePnlInstruction } from './instructions/settlement';
import { buildLiquidatePerpInstruction } from './instructions/liquidation';
import { buildUpdateFundingRateInstruction } from './instructions/funding';
import {
	buildCancelOrderByUserIdInstruction,
	buildCancelOrderInstruction,
	buildCancelOrdersByIdsInstruction,
	buildModifyOrderByUserIdInstruction,
	buildModifyOrderInstruction,
	buildPlaceAndMakePerpOrderInstruction,
	buildPlaceAndTakePerpOrderInstruction,
	buildPlacePerpOrderInstruction,
} from './instructions/perpOrders';
import * as remainingAccounts from './remainingAccounts';
import * as signedMsg from './signedMsg';

export type VelocityCoreContext = {
	/** Drift program id. */
	programId: PublicKey;

	/** Anchor IDL json for Drift (defaults to bundled `idl/drift.json`). */
	idl?: Drift;
};

/** @deprecated Use `VelocityCoreContext` instead. `DriftCoreContext` will be removed in a future major. */
export type DriftCoreContext = VelocityCoreContext;

/**
 * VelocityCore is the minimal, core SDK surface:
 * - No subscriptions / polling / websockets.
 * - Pure helpers for PDAs, decoding, constants, and instruction building.
 *
 * Transaction/instruction builders will be progressively moved here from `VelocityClient`.
 */
export class VelocityCore {
	/** Re-export PDA helpers (pure). */
	static readonly pdas = pdas;

	/** Re-export SDK constants (market configs, numeric constants, etc). */
	static readonly constants = constants;

	/** Re-export remaining-accounts logic (pure). */
	static readonly remainingAccounts = remainingAccounts;
	static readonly signedMsg = signedMsg;

	static defaultIdl(): Drift {
		return driftIDL as unknown as Drift;
	}

	static coder(idl: Drift = VelocityCore.defaultIdl()): CustomBorshCoder {
		return new CustomBorshCoder(idl as any);
	}

	/** Decode a Drift `User` account buffer without creating a Program. */
	static decodeUserAccount(buffer: Buffer): UserAccount {
		return decodeUser(buffer);
	}

	/** Fetch and decode a Drift `User` account. */
	static async fetchUserAccount(
		connection: Connection,
		userAccountPublicKey: PublicKey
	): Promise<UserAccount | null> {
		const data = await fetchAccount(connection, userAccountPublicKey);
		return data ? VelocityCore.decodeUserAccount(data) : null;
	}

	static async buildDepositInstruction(args: {
		program: VelocityProgram;
		marketIndex: number;
		amount: BN;
		reduceOnly: boolean;
		state: PublicKey;
		spotMarket: PublicKey;
		spotMarketVault: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		userTokenAccount: PublicKey;
		authority: PublicKey;
		tokenProgram: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildDepositInstruction(args);
	}

	static async buildWithdrawInstruction(args: {
		program: VelocityProgram;
		marketIndex: number;
		amount: BN;
		reduceOnly: boolean;
		state: PublicKey;
		spotMarket: PublicKey;
		spotMarketVault: PublicKey;
		driftSigner: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		userTokenAccount: PublicKey;
		authority: PublicKey;
		tokenProgram: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildWithdrawInstruction(args);
	}

	static async buildPlaceOrdersInstruction(args: {
		program: VelocityProgram;
		formattedParams: any[];
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildPlaceOrdersInstruction(args);
	}

	static async buildCancelOrdersInstruction(args: {
		program: VelocityProgram;
		marketType: any;
		marketIndex: number | null;
		direction: any;
		user: PublicKey;
		state: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildCancelOrdersInstruction(args);
	}

	static async buildFillPerpOrderInstruction(args: {
		program: VelocityProgram;
		orderId: number | null;
		state: PublicKey;
		filler: PublicKey;
		fillerStats: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildFillPerpOrderInstruction(args);
	}

	static async buildTriggerOrderInstruction(args: {
		program: VelocityProgram;
		orderId: number;
		state: PublicKey;
		filler: PublicKey;
		user: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildTriggerOrderInstruction(args);
	}

	static async buildSettlePnlInstruction(args: {
		program: VelocityProgram;
		marketIndex: number;
		state: PublicKey;
		authority: PublicKey;
		user: PublicKey;
		spotMarketVault: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildSettlePnlInstruction(args);
	}

	static async buildLiquidatePerpInstruction(args: {
		program: VelocityProgram;
		marketIndex: number;
		maxBaseAssetAmount: any;
		limitPrice: any | null;
		state: PublicKey;
		authority: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		liquidator: PublicKey;
		liquidatorStats: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildLiquidatePerpInstruction(args);
	}

	static async buildPlacePerpOrderInstruction(args: {
		program: VelocityProgram;
		orderParams: any;
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildPlacePerpOrderInstruction(args);
	}

	static async buildPlaceAndTakePerpOrderInstruction(args: {
		program: VelocityProgram;
		orderParams: any;
		optionalParams: number | null;
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildPlaceAndTakePerpOrderInstruction(args);
	}

	static async buildPlaceAndMakePerpOrderInstruction(args: {
		program: VelocityProgram;
		orderParams: any;
		takerOrderId: number;
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		taker: PublicKey;
		takerStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildPlaceAndMakePerpOrderInstruction(args);
	}

	static async buildCancelOrderInstruction(args: {
		program: VelocityProgram;
		orderId: number | null;
		state: PublicKey;
		user: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildCancelOrderInstruction(args);
	}

	static async buildCancelOrderByUserIdInstruction(args: {
		program: VelocityProgram;
		userOrderId: number;
		state: PublicKey;
		user: PublicKey;
		authority: PublicKey;
		oracle: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildCancelOrderByUserIdInstruction(args);
	}

	static async buildCancelOrdersByIdsInstruction(args: {
		program: VelocityProgram;
		orderIds: number[] | undefined;
		state: PublicKey;
		user: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildCancelOrdersByIdsInstruction(args);
	}

	static async buildModifyOrderInstruction(args: {
		program: VelocityProgram;
		orderId: number;
		modifyParams: any;
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildModifyOrderInstruction(args);
	}

	static async buildModifyOrderByUserIdInstruction(args: {
		program: VelocityProgram;
		userOrderId: number;
		modifyParams: any;
		state: PublicKey;
		user: PublicKey;
		userStats: PublicKey;
		authority: PublicKey;
		remainingAccounts: AccountMeta[];
	}): Promise<TransactionInstruction> {
		return await buildModifyOrderByUserIdInstruction(args);
	}

	static async buildUpdateFundingRateInstruction(args: {
		program: VelocityProgram;
		perpMarketIndex: number;
		state: PublicKey;
		perpMarket: PublicKey;
		oracle: PublicKey;
	}): Promise<TransactionInstruction> {
		return await buildUpdateFundingRateInstruction(args);
	}

	/**
	 * Placeholder for instruction builders.
	 *
	 * In follow-up refactors, VelocityClient methods like `getDepositInstruction`,
	 * `getPlaceOrdersIx`, etc. will be moved here as pure builders.
	 */
	static buildInstructions(
		_ctx: VelocityCoreContext
	): TransactionInstruction[] {
		return [];
	}
}

/** @deprecated Use `VelocityCore` instead. `DriftCore` will be removed in a future major. */
export const DriftCore = VelocityCore;

/** @deprecated Use `VelocityCore` instead. `DriftCore` will be removed in a future major. */
export type DriftCore = VelocityCore;

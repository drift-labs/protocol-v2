import { BN, DataAndSlot, Event } from '@velocity-exchange/sdk';
import { PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import StrictEventEmitter from 'strict-event-emitter-types';

export const VAULT_PROGRAM_ID = new PublicKey(
	'vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR'
);

export class WithdrawUnit {
	static readonly SHARES = { shares: {} };
	static readonly TOKEN = { token: {} };
	static readonly SHARES_PERCENT = { sharesPercent: {} };
}

export type WithdrawRequest = {
	shares: BN;
	value: BN;
	ts: BN;
};

export type VaultParams = {
	name: number[];
	spotMarketIndex: number;
	redeemPeriod: BN;
	maxTokens: BN;
	minDepositAmount: BN;
	managementFee: BN;
	profitShare: number;
	hurdleRate: number;
	permissioned: boolean;
};

export type VaultWithProtocolParams = {
	name: number[];
	spotMarketIndex: number;
	redeemPeriod: BN;
	maxTokens: BN;
	minDepositAmount: BN;
	managementFee: BN;
	profitShare: number;
	hurdleRate: number;
	permissioned: boolean;
	vaultProtocol: VaultProtocolParams;
};

export type VaultProtocolParams = {
	protocol: PublicKey;
	protocolFee: BN;
	protocolProfitShare: number;
};

export type UpdateVaultParams = {
	redeemPeriod: BN | null;
	maxTokens: BN | null;
	minDepositAmount: BN | null;
	managementFee: BN | null;
	profitShare: number | null;
	hurdleRate: number | null;
	permissioned: boolean | null;
};

export type UpdateVaultProtocolParams = {
	protocolFee: BN | null;
	protocolProfitShare: number | null;
};

// Vault program accounts

export type Vault = {
	name: number[];
	pubkey: PublicKey;
	manager: PublicKey;
	tokenAccount: PublicKey;
	userStats: PublicKey;
	user: PublicKey;
	delegate: PublicKey;
	liquidationDelegate: PublicKey;
	userShares: BN;
	totalShares: BN;
	lastFeeUpdateTs: BN;
	liquidationStartTs: BN;
	redeemPeriod: BN;
	totalWithdrawRequested: BN;
	maxTokens: BN;
	sharesBase: number;
	managementFee: BN;
	initTs: BN;
	netDeposits: BN;
	managerNetDeposits: BN;
	totalDeposits: BN;
	totalWithdraws: BN;
	managerTotalDeposits: BN;
	managerTotalWithdraws: BN;
	managerTotalFee: BN;
	managerTotalProfitShare: BN;
	minDepositAmount: BN;
	profitShare: number;
	hurdleRate: number;
	spotMarketIndex: number;
	bump: number;
	permissioned: boolean;
	lastManagerWithdrawRequest: WithdrawRequest;
	vaultProtocol: boolean;
	feeUpdateStatus: FeeUpdateStatus;
	vaultClass: VaultClass;
	managerBorrowedValue: BN;
	padding: number[];
};

export enum VaultClass {
	NORMAL = 0,
	TRUSTED = 1,
}

export function isNormalVaultClass(vaultClass: number | VaultClass): boolean {
	return (vaultClass & VaultClass.NORMAL) === VaultClass.NORMAL;
}

export function isTrustedVaultClass(vaultClass: number | VaultClass): boolean {
	return (vaultClass & VaultClass.TRUSTED) === VaultClass.TRUSTED;
}

export enum FeeUpdateStatus {
	None = 0,
	PendingFeeUpdate = 1,
}

export function hasPendingFeeUpdate(status: number | FeeUpdateStatus): boolean {
	return (
		(status & FeeUpdateStatus.PendingFeeUpdate) ===
		FeeUpdateStatus.PendingFeeUpdate
	);
}

export type FeeUpdate = {
	incomingUpdateTs: BN;
	incomingManagementFee: BN;
	incomingProfitShare: number;
	incomingHurdleRate: number;
	padding: BN[];
	padding2: number[];
};

export type VaultDepositor = {
	vault: PublicKey;
	pubkey: PublicKey;
	authority: PublicKey;
	vaultShares: BN;
	lastWithdrawRequest: WithdrawRequest;
	lastValidTs: BN;
	netDeposits: BN;
	totalDeposits: BN;
	totalWithdraws: BN;
	cumulativeProfitShareAmount: BN;
	vaultSharesBase: number;
	profitShareFeePaid: BN;
	paddingAlign: number;
	padding: BN[];
};

export type VaultProtocol = {
	protocol: PublicKey;
	protocolProfitAndFeeShares: BN;
	protocolFee: BN;
	protocolTotalWithdraws: BN;
	protocolTotalFee: BN;
	protocolTotalProfitShare: BN;
	lastProtocolWithdrawRequest: WithdrawRequest;
	protocolProfitShare: number;
	bump: number;
	version: number;
};

export type VaultsProgramAccountBaseEvents = {
	update: void;
	error: (e: Error) => void;
};

export type VaultDepositorAccountEvents = {
	vaultDepositorUpdate: (payload: VaultDepositor) => void;
} & VaultsProgramAccountBaseEvents;

export type VaultAccountEvents = {
	vaultUpdate: (payload: Vault) => void;
} & VaultsProgramAccountBaseEvents;

export interface VaultsProgramAccountSubscriber<
	Account,
	AccountEvents extends VaultsProgramAccountBaseEvents,
> {
	eventEmitter: StrictEventEmitter<EventEmitter, AccountEvents>;
	isSubscribed: boolean;

	subscribe(): Promise<boolean>;

	fetch(): Promise<void>;

	updateData(account: Account, slot: number): void;

	unsubscribe(): Promise<void>;

	getAccountAndSlot(): DataAndSlot<Account>;
}

export type VaultAccountSubscriber = VaultsProgramAccountSubscriber<
	Vault,
	VaultAccountEvents
>;

export type VaultDepositorAccountSubscriber = VaultsProgramAccountSubscriber<
	VaultDepositor,
	VaultDepositorAccountEvents
>;

// Logs/Records

export class VaultDepositorAction {
	static readonly DEPOSIT = { deposit: {} };
	static readonly WITHDRAW = { withdraw: {} };
	static readonly WITHDRAW_REQUEST = { withdrawRequest: {} };
	static readonly CANCEL_WITHDRAW_REQUEST = { cancelWithdrawRequest: {} };
	static readonly FEE_PAYMENT = { feePayment: {} };
}

export type VaultDepositorRecord = {
	ts: BN;

	vault: PublicKey;
	depositorAuthority: PublicKey;
	action: VaultDepositorAction;
	amount: BN;

	spotMarketIndex: number;
	vaultSharesBefore: BN;
	vaultSharesAfter: BN;
	vaultEquityBefore: BN;

	userVaultSharesBefore: BN;
	totalVaultSharesBefore: BN;

	userVaultSharesAfter: BN;
	totalVaultSharesAfter: BN;

	profitShare: BN;
	managementFee: BN;
	managementFeeShares: BN;

	depositOraclePrice: BN;
};

export type VaultDepositorV1Record = {
	ts: BN;

	vault: PublicKey;
	depositorAuthority: PublicKey;
	action: VaultDepositorAction;
	amount: BN;

	spotMarketIndex: number;
	vaultSharesBefore: BN;
	vaultSharesAfter: BN;
	vaultEquityBefore: BN;

	userVaultSharesBefore: BN;
	totalVaultSharesBefore: BN;

	userVaultSharesAfter: BN;
	totalVaultSharesAfter: BN;

	protocolProfitShare: BN;
	protocolFee: BN;
	protocolFeeShares: BN;

	managerProfitShare: BN;
	managementFee: BN;
	managementFeeShares: BN;

	depositOraclePrice: BN;
};

export type VaultsEventMap = {
	VaultDepositorRecord: Event<VaultDepositorRecord>;
	VaultDepositorV1Record: Event<VaultDepositorV1Record>;
};

export type EventType = keyof VaultsEventMap;
export type WrappedEvent<Type extends EventType> = VaultsEventMap[Type] & {
	eventType: Type;
};
export type WrappedEvents = WrappedEvent<EventType>[];

export class FeeUpdateAction {
	static readonly PENDING = { pending: {} };
	static readonly APPLIED = { applied: {} };
}

export type FeeUpdateRecord = {
	ts: BN;
	action: FeeUpdateAction;
	timelockEndTs: BN;
	vault: PublicKey;
	oldManagementFee: BN;
	oldProfitShare: number;
	oldHurdleRate: number;
	newManagementFee: BN;
	newProfitShare: number;
	newHurdleRate: number;
};

export type ManagerBorrowRecord = {
	ts: BN;
	vault: PublicKey;
	manager: PublicKey;
	borrowAmount: BN;
	borrowValue: BN;
	borrowSpotMarketIndex: number;
	borrowOraclePrice: BN;
	depositSpotMarketIndex: number;
	depositOraclePrice: BN;
	vaultEquity: BN;
};

export type ManagerRepayRecord = {
	ts: BN;
	vault: PublicKey;
	manager: PublicKey;
	repayAmount: BN;
	repayValue: BN;
	repaySpotMarketIndex: number;
	repayOraclePrice: BN;
	depositSpotMarketIndex: number;
	depositOraclePrice: BN;
	vaultEquityBefore: BN;
	vaultEquityAfter: BN;
};

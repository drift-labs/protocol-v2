import {
	PublicKey,
	SYSVAR_RENT_PUBKEY,
	TransactionSignature,
} from '@solana/web3.js';
import {
	FeeStructure,
	OracleGuardRails,
	OracleSource,
	OrderFillerRewardStructure,
} from './types';
import { BN } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import {
	getClearingHouseStateAccountPublicKeyAndNonce,
	getBankVaultAuthorityPublicKey,
	getBankPublicKey,
	getBankVaultPublicKey,
	getMarketPublicKey,
} from './addresses/pda';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ClearingHouse } from './clearingHouse';
import { PEG_PRECISION } from './constants/numericConstants';
import { calculateTargetPriceTrade } from './math/trade';
import { calculateAmmReservesAfterSwap, getSwapDirection } from './math/amm';

export class Admin extends ClearingHouse {
	public async initialize(
		usdcMint: PublicKey,
		adminControlsPrices: boolean
	): Promise<[TransactionSignature]> {
		const stateAccountRPCResponse = await this.connection.getParsedAccountInfo(
			await this.getStatePublicKey()
		);
		if (stateAccountRPCResponse.value !== null) {
			throw new Error('Clearing house already initialized');
		}

		const [insuranceVaultPublicKey] = await PublicKey.findProgramAddress(
			[Buffer.from(anchor.utils.bytes.utf8.encode('insurance_vault'))],
			this.program.programId
		);

		const [insuranceVaultAuthority] = await PublicKey.findProgramAddress(
			[insuranceVaultPublicKey.toBuffer()],
			this.program.programId
		);

		const [clearingHouseStatePublicKey] =
			await getClearingHouseStateAccountPublicKeyAndNonce(
				this.program.programId
			);
		const initializeTx = await this.program.transaction.initialize(
			adminControlsPrices,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: clearingHouseStatePublicKey,
					quoteAssetMint: usdcMint,
					insuranceVault: insuranceVaultPublicKey,
					insuranceVaultAuthority: insuranceVaultAuthority,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);

		const { txSig: initializeTxSig } = await this.txSender.send(
			initializeTx,
			[],
			this.opts
		);

		return [initializeTxSig];
	}

	public async initializeBank(
		mint: PublicKey,
		optimalUtilization: BN,
		optimalRate: BN,
		maxRate: BN,
		oracle: PublicKey,
		oracleSource: OracleSource,
		initialAssetWeight: BN,
		maintenanceAssetWeight: BN,
		initialLiabilityWeight: BN,
		maintenanceLiabilityWeight: BN
	): Promise<TransactionSignature> {
		const bankIndex = this.getStateAccount().numberOfBanks;
		const bank = await getBankPublicKey(this.program.programId, bankIndex);

		const bankVault = await getBankVaultPublicKey(
			this.program.programId,
			bankIndex
		);

		const bankVaultAuthority = await getBankVaultAuthorityPublicKey(
			this.program.programId,
			bankIndex
		);

		const initializeTx = await this.program.transaction.initializeBank(
			optimalUtilization,
			optimalRate,
			maxRate,
			oracleSource,
			initialAssetWeight,
			maintenanceAssetWeight,
			initialLiabilityWeight,
			maintenanceLiabilityWeight,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					bank,
					bankVault,
					bankVaultAuthority,
					bankMint: mint,
					oracle,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);

		const { txSig } = await this.txSender.send(initializeTx, [], this.opts);

		await this.accountSubscriber.addBank(bankIndex);
		await this.accountSubscriber.addOracle({
			source: oracleSource,
			publicKey: oracle,
		});

		return txSig;
	}

	public async initializeMarket(
		priceOracle: PublicKey,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		periodicity: BN,
		pegMultiplier: BN = PEG_PRECISION,
		oracleSource: OracleSource = OracleSource.PYTH,
		marginRatioInitial = 2000,
		marginRatioPartial = 625,
		marginRatioMaintenance = 500
	): Promise<TransactionSignature> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			this.getStateAccount().numberOfMarkets
		);

		const initializeMarketTx = await this.program.transaction.initializeMarket(
			baseAssetReserve,
			quoteAssetReserve,
			periodicity,
			pegMultiplier,
			oracleSource,
			marginRatioInitial,
			marginRatioPartial,
			marginRatioMaintenance,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					oracle: priceOracle,
					market: marketPublicKey,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
				},
			}
		);
		const { txSig } = await this.txSender.send(
			initializeMarketTx,
			[],
			this.opts
		);

		await this.accountSubscriber.addMarket(
			this.getStateAccount().numberOfMarkets
		);
		await this.accountSubscriber.addOracle({
			source: oracleSource,
			publicKey: priceOracle,
		});

		return txSig;
	}

	public async moveAmmPrice(
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		return await this.program.rpc.moveAmmPrice(
			baseAssetReserve,
			quoteAssetReserve,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					market: marketPublicKey,
				},
			}
		);
	}

	public async updateK(
		sqrtK: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateK(sqrtK, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				market: await getMarketPublicKey(this.program.programId, marketIndex),
				oracle: this.getMarketAccount(marketIndex).amm.oracle,
			},
		});
	}

	public async moveAmmToPrice(
		marketIndex: BN,
		targetPrice: BN
	): Promise<TransactionSignature> {
		const market = this.getMarketAccount(marketIndex);

		const [direction, tradeSize, _] = calculateTargetPriceTrade(
			market,
			targetPrice,
			new BN(1000),
			'quote',
			undefined //todo
		);

		const [newQuoteAssetAmount, newBaseAssetAmount] =
			calculateAmmReservesAfterSwap(
				market.amm,
				'quote',
				tradeSize,
				getSwapDirection('quote', direction)
			);

		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		return await this.program.rpc.moveAmmPrice(
			newBaseAssetAmount,
			newQuoteAssetAmount,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					market: marketPublicKey,
				},
			}
		);
	}

	public async repegAmmCurve(
		newPeg: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const ammData = this.getMarketAccount(marketIndex).amm;

		return await this.program.rpc.repegAmmCurve(newPeg, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				market: marketPublicKey,
			},
		});
	}

	public async updateAmmOracleTwap(
		marketIndex: BN
	): Promise<TransactionSignature> {
		const ammData = this.getMarketAccount(marketIndex).amm;
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		return await this.program.rpc.updateAmmOracleTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				market: marketPublicKey,
			},
		});
	}

	public async resetAmmOracleTwap(
		marketIndex: BN
	): Promise<TransactionSignature> {
		const ammData = this.getMarketAccount(marketIndex).amm;
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);

		return await this.program.rpc.resetAmmOracleTwap({
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				market: marketPublicKey,
			},
		});
	}

	public async withdrawFromInsuranceVault(
		amount: BN,
		recipient: PublicKey
	): Promise<TransactionSignature> {
		const state = await this.getStateAccount();
		return await this.program.rpc.withdrawFromInsuranceVault(amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				insuranceVault: state.insuranceVault,
				insuranceVaultAuthority: state.insuranceVaultAuthority,
				recipient: recipient,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async withdrawFees(
		marketIndex: BN,
		amount: BN,
		recipient: PublicKey
	): Promise<TransactionSignature> {
		const marketPublicKey = await getMarketPublicKey(
			this.program.programId,
			marketIndex
		);
		const bank = this.getQuoteAssetBankAccount();
		return await this.program.rpc.withdrawFees(amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: marketPublicKey,
				bank: bank.pubkey,
				bankVault: bank.vault,
				bankVaultAuthority: bank.vaultAuthority,
				recipient: recipient,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async withdrawFromInsuranceVaultToMarket(
		marketIndex: BN,
		amount: BN
	): Promise<TransactionSignature> {
		const state = await this.getStateAccount();
		return await this.program.rpc.withdrawFromInsuranceVaultToMarket(amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
				insuranceVault: state.insuranceVault,
				insuranceVaultAuthority: state.insuranceVaultAuthority,
				bankVault: this.getQuoteAssetBankAccount().vault,
				tokenProgram: TOKEN_PROGRAM_ID,
			},
		});
	}

	public async updateAdmin(admin: PublicKey): Promise<TransactionSignature> {
		return await this.program.rpc.updateAdmin(admin, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateCurveUpdateIntensity(
		marketIndex: BN,
		curveUpdateIntensity: number
	): Promise<TransactionSignature> {
		// assert(curveUpdateIntensity >= 0 && curveUpdateIntensity <= 100);
		// assert(Number.isInteger(curveUpdateIntensity));

		return await this.program.rpc.updateCurveUpdateIntensity(
			curveUpdateIntensity,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					market: await getMarketPublicKey(this.program.programId, marketIndex),
				},
			}
		);
	}

	public async updateMarginRatio(
		marketIndex: BN,
		marginRatioInitial: number,
		marginRatioPartial: number,
		marginRatioMaintenance: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarginRatio(
			marginRatioInitial,
			marginRatioPartial,
			marginRatioMaintenance,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					market: await getMarketPublicKey(this.program.programId, marketIndex),
				},
			}
		);
	}

	public async updateMarketBaseSpread(
		marketIndex: BN,
		baseSpread: number
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketBaseSpread(baseSpread, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
			},
		});
	}

	public async updatePartialLiquidationClosePercentage(
		numerator: BN,
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePartialLiquidationClosePercentage(
			numerator,
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updatePartialLiquidationPenaltyPercentage(
		numerator: BN,
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePartialLiquidationPenaltyPercentage(
			numerator,
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFullLiquidationPenaltyPercentage(
		numerator: BN,
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateFullLiquidationPenaltyPercentage(
			numerator,
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updatePartialLiquidationShareDenominator(
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updatePartialLiquidationLiquidatorShareDenominator(
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFullLiquidationShareDenominator(
		denominator: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateFullLiquidationLiquidatorShareDenominator(
			denominator,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateOrderFillerRewardStructure(
		orderFillerRewardStructure: OrderFillerRewardStructure
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateOrderFillerRewardStructure(
			orderFillerRewardStructure,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
	}

	public async updateFee(fees: FeeStructure): Promise<TransactionSignature> {
		return await this.program.rpc.updateFee(fees, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateOracleGuardRails(
		oracleGuardRails: OracleGuardRails
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateOracleGuardRails(oracleGuardRails, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateMarketOracle(
		marketIndex: BN,
		oracle: PublicKey,
		oracleSource: OracleSource
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketOracle(oracle, oracleSource, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				market: await getMarketPublicKey(this.program.programId, marketIndex),
			},
		});
	}

	public async updateMarketMinimumQuoteAssetTradeSize(
		marketIndex: BN,
		minimumTradeSize: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketMinimumQuoteAssetTradeSize(
			minimumTradeSize,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					market: await getMarketPublicKey(this.program.programId, marketIndex),
				},
			}
		);
	}

	public async updateMarketMinimumBaseAssetTradeSize(
		marketIndex: BN,
		minimumTradeSize: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarketMinimumBaseAssetTradeSize(
			minimumTradeSize,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					market: await getMarketPublicKey(this.program.programId, marketIndex),
				},
			}
		);
	}

	public async updateWhitelistMint(
		whitelistMint?: PublicKey
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateWhitelistMint(whitelistMint, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateDiscountMint(
		discountMint: PublicKey
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateDiscountMint(discountMint, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateMaxDeposit(maxDeposit: BN): Promise<TransactionSignature> {
		return await this.program.rpc.updateMaxDeposit(maxDeposit, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateFundingPaused(
		fundingPaused: boolean
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateFundingPaused(fundingPaused, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateExchangePaused(
		exchangePaused: boolean
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateExchangePaused(exchangePaused, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async disableAdminControlsPrices(): Promise<TransactionSignature> {
		return await this.program.rpc.disableAdminControlsPrices({
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}
}

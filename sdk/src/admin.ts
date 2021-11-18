import {
	ConfirmOptions,
	Connection,
	PublicKey,
	SYSVAR_RENT_PUBKEY,
	TransactionSignature,
} from '@solana/web3.js';
import { FeeStructure, IWallet, OracleGuardRails, OracleSource } from './types';
import { BN, Idl, Program, Provider } from '@project-serum/anchor';
import * as anchor from '@project-serum/anchor';
import { getClearingHouseStateAccountPublicKeyAndNonce } from './addresses';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ClearingHouse } from './clearingHouse';
import { PEG_PRECISION } from './constants/numericConstants';
import clearingHouseIDL from './idl/clearing_house.json';
import { DefaultClearingHouseAccountSubscriber } from './accounts/defaultClearingHouseAccountSubscriber';
import { DefaultTxSender } from './tx/defaultTxSender';
import { calculateTargetPriceTrade } from './math/trade';
import { calculateAmmReservesAfterSwap, getSwapDirection } from './math/amm';

export class Admin extends ClearingHouse {
	public static from(
		connection: Connection,
		wallet: IWallet,
		clearingHouseProgramId: PublicKey,
		opts: ConfirmOptions = Provider.defaultOptions()
	): Admin {
		const provider = new Provider(connection, wallet, opts);
		const program = new Program(
			clearingHouseIDL as Idl,
			clearingHouseProgramId,
			provider
		);
		const accountSubscriber = new DefaultClearingHouseAccountSubscriber(
			program
		);
		const txSender = new DefaultTxSender(provider);
		return new Admin(
			connection,
			wallet,
			program,
			accountSubscriber,
			txSender,
			opts
		);
	}

	public async initialize(
		usdcMint: PublicKey,
		adminControlsPrices: boolean
	): Promise<[TransactionSignature, TransactionSignature]> {
		const stateAccountRPCResponse = await this.connection.getParsedAccountInfo(
			await this.getStatePublicKey()
		);
		if (stateAccountRPCResponse.value !== null) {
			throw new Error('Clearing house already initialized');
		}

		const [collateralVaultPublicKey, collateralVaultNonce] =
			await PublicKey.findProgramAddress(
				[Buffer.from(anchor.utils.bytes.utf8.encode('collateral_vault'))],
				this.program.programId
			);

		const [collateralVaultAuthority, _collateralVaultAuthorityNonce] =
			await PublicKey.findProgramAddress(
				[collateralVaultPublicKey.toBuffer()],
				this.program.programId
			);

		const [insuranceVaultPublicKey, insuranceVaultNonce] =
			await PublicKey.findProgramAddress(
				[Buffer.from(anchor.utils.bytes.utf8.encode('insurance_vault'))],
				this.program.programId
			);

		const [insuranceVaultAuthority, _insuranceVaultAuthorityNonce] =
			await PublicKey.findProgramAddress(
				[insuranceVaultPublicKey.toBuffer()],
				this.program.programId
			);

		const markets = anchor.web3.Keypair.generate();
		const depositHistory = anchor.web3.Keypair.generate();
		const fundingRateHistory = anchor.web3.Keypair.generate();
		const fundingPaymentHistory = anchor.web3.Keypair.generate();
		const tradeHistory = anchor.web3.Keypair.generate();
		const liquidationHistory = anchor.web3.Keypair.generate();
		const curveHistory = anchor.web3.Keypair.generate();

		const [clearingHouseStatePublicKey, clearingHouseNonce] =
			await getClearingHouseStateAccountPublicKeyAndNonce(
				this.program.programId
			);
		const initializeTx = await this.program.transaction.initialize(
			clearingHouseNonce,
			collateralVaultNonce,
			insuranceVaultNonce,
			adminControlsPrices,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: clearingHouseStatePublicKey,
					collateralMint: usdcMint,
					collateralVault: collateralVaultPublicKey,
					collateralVaultAuthority: collateralVaultAuthority,
					insuranceVault: insuranceVaultPublicKey,
					insuranceVaultAuthority: insuranceVaultAuthority,
					markets: markets.publicKey,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
				instructions: [
					await this.program.account.markets.createInstruction(markets),
				],
			}
		);

		const initializeTxSig = await this.txSender.send(
			initializeTx,
			[markets],
			this.opts
		);

		const initializeHistoryTx =
			await this.program.transaction.initializeHistory({
				accounts: {
					admin: this.wallet.publicKey,
					state: clearingHouseStatePublicKey,
					depositHistory: depositHistory.publicKey,
					fundingRateHistory: fundingRateHistory.publicKey,
					fundingPaymentHistory: fundingPaymentHistory.publicKey,
					tradeHistory: tradeHistory.publicKey,
					liquidationHistory: liquidationHistory.publicKey,
					curveHistory: curveHistory.publicKey,
					rent: SYSVAR_RENT_PUBKEY,
					systemProgram: anchor.web3.SystemProgram.programId,
				},
				instructions: [
					await this.program.account.fundingRateHistory.createInstruction(
						fundingRateHistory
					),
					await this.program.account.fundingPaymentHistory.createInstruction(
						fundingPaymentHistory
					),
					await this.program.account.tradeHistory.createInstruction(
						tradeHistory
					),
					await this.program.account.liquidationHistory.createInstruction(
						liquidationHistory
					),
					await this.program.account.depositHistory.createInstruction(
						depositHistory
					),
					await this.program.account.curveHistory.createInstruction(
						curveHistory
					),
				],
			});

		const initializeHistoryTxSig = await this.txSender.send(
			initializeHistoryTx,
			[
				depositHistory,
				fundingPaymentHistory,
				tradeHistory,
				liquidationHistory,
				fundingRateHistory,
				curveHistory,
			],
			this.opts
		);

		return [initializeTxSig, initializeHistoryTxSig];
	}

	public async initializeMarket(
		marketIndex: BN,
		priceOracle: PublicKey,
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		periodicity: BN,
		pegMultiplier: BN = PEG_PRECISION
	): Promise<TransactionSignature> {
		if (this.getMarketsAccount().markets[marketIndex.toNumber()].initialized) {
			throw Error(`MarketIndex ${marketIndex.toNumber()} already initialized`);
		}

		const initializeMarketTx = await this.program.transaction.initializeMarket(
			marketIndex,
			baseAssetReserve,
			quoteAssetReserve,
			periodicity,
			pegMultiplier,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					oracle: priceOracle,
					markets: this.getStateAccount().markets,
				},
			}
		);
		return await this.txSender.send(initializeMarketTx, [], this.opts);
	}

	public async moveAmmPrice(
		baseAssetReserve: BN,
		quoteAssetReserve: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const state = this.getStateAccount();
		return await this.program.rpc.moveAmmPrice(
			baseAssetReserve,
			quoteAssetReserve,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					markets: state.markets,
				},
			}
		);
	}

	public async updateK(
		sqrtK: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const state = this.getStateAccount();
		return await this.program.rpc.updateK(sqrtK, marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				markets: state.markets,
				curveHistory: state.curveHistory,
			},
		});
	}

	public async moveAmmToPrice(
		marketIndex: BN,
		targetPrice: BN
	): Promise<TransactionSignature> {
		const market = this.getMarket(marketIndex);

		const [direction, tradeSize, _] = calculateTargetPriceTrade(
			market,
			targetPrice
		);

		const [newQuoteAssetAmount, newBaseAssetAmount] =
			calculateAmmReservesAfterSwap(
				market.amm,
				'quote',
				tradeSize,
				getSwapDirection('quote', direction)
			);

		const state = this.getStateAccount();
		return await this.program.rpc.moveAmmPrice(
			newBaseAssetAmount,
			newQuoteAssetAmount,
			marketIndex,
			{
				accounts: {
					state: await this.getStatePublicKey(),
					admin: this.wallet.publicKey,
					markets: state.markets,
				},
			}
		);
	}

	public async repegAmmCurve(
		newPeg: BN,
		marketIndex: BN
	): Promise<TransactionSignature> {
		const state = this.getStateAccount();
		const markets = this.getMarketsAccount();
		const marketData = markets.markets[marketIndex.toNumber()];
		const ammData = marketData.amm;

		return await this.program.rpc.repegAmmCurve(newPeg, marketIndex, {
			accounts: {
				state: await this.getStatePublicKey(),
				admin: this.wallet.publicKey,
				oracle: ammData.oracle,
				markets: state.markets,
				curveHistory: state.curveHistory,
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
		const state = await this.getStateAccount();
		return await this.program.rpc.withdrawFees(marketIndex, amount, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
				markets: state.markets,
				collateralVault: state.collateralVault,
				collateralVaultAuthority: state.collateralVaultAuthority,
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
		return await this.program.rpc.withdrawFromInsuranceVaultToMarket(
			marketIndex,
			amount,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					markets: state.markets,
					insuranceVault: state.insuranceVault,
					insuranceVaultAuthority: state.insuranceVaultAuthority,
					collateralVault: state.collateralVault,
					tokenProgram: TOKEN_PROGRAM_ID,
				},
			}
		);
	}

	public async updateAdmin(admin: PublicKey): Promise<TransactionSignature> {
		return await this.program.rpc.updateAdmin(admin, {
			accounts: {
				admin: this.wallet.publicKey,
				state: await this.getStatePublicKey(),
			},
		});
	}

	public async updateMarginRatio(
		marginRatioInitial: BN,
		marginRatioPartial: BN,
		marginRatioMaintenance: BN
	): Promise<TransactionSignature> {
		return await this.program.rpc.updateMarginRatio(
			marginRatioInitial,
			marginRatioPartial,
			marginRatioMaintenance,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
				},
			}
		);
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
		const state = this.getStateAccount();
		return await this.program.rpc.updateMarketOracle(
			marketIndex,
			oracle,
			oracleSource,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					markets: state.markets,
				},
			}
		);
	}

	public async updateMarketMinimumTradeSize(
		marketIndex: BN,
		minimumTradeSize: BN
	): Promise<TransactionSignature> {
		const state = this.getStateAccount();
		return await this.program.rpc.updateMarketMinimumTradeSize(
			marketIndex,
			minimumTradeSize,
			{
				accounts: {
					admin: this.wallet.publicKey,
					state: await this.getStatePublicKey(),
					markets: state.markets,
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

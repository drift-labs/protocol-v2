import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN, ClearingHouseUser, QUOTE_ASSET_BANK_INDEX } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Admin,
	ClearingHouse,
	EventSubscriber,
	findComputeUnitConsumption,
	MARK_PRICE_PRECISION,
	PositionDirection,
} from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
} from './testHelpers';

describe('liquidity providing', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(30 * 10 ** 8);

	const maxPositions = 5;
    let clearingHouseUser: ClearingHouseUser;
	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0), new BN(1), new BN(2), new BN(3), new BN(4)],
			[new BN(0)]
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();



		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);
		await clearingHouse.initializeMarket(
			await mockOracle(1),
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0)
		);
		
		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

        clearingHouseUser = ClearingHouseUser.from(clearingHouse, provider.wallet.publicKey)
        clearingHouseUser.subscribe()
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
        await clearingHouseUser.unsubscribe();
	});

	it('provides liquidity', async () => {
		const marketAccount = clearingHouse.getMarketAccount(0);
		var market = await chProgram.account.market.fetch(marketAccount.pubkey);
		console.log(market.amm.sqrtK.toString())

        await chProgram.methods.addLiquidity(
            new BN(100), 
            new BN(0), 
        )
        .accounts({
            state: await clearingHouse.getStatePublicKey(),
            user: await clearingHouse.getUserAccountPublicKey(), 
            authority: clearingHouse.wallet.publicKey, 
            oracle: clearingHouse.getMarketAccount(0).amm.oracle
        })
        .remainingAccounts(clearingHouse.getRemainingAccounts({
            writableBankIndex: QUOTE_ASSET_BANK_INDEX,
            writableMarketIndex: new BN(0),
        }))
        .rpc()

		var market = await chProgram.account.market.fetch(marketAccount.pubkey);
		console.log(market.amm.sqrtK.toString())

        let user = await chProgram.account.user.fetch(await clearingHouse.getUserAccountPublicKey())
        console.log(user.positions[0].lpTokens.toString())
		console.log(user.positions[0])
    });
});

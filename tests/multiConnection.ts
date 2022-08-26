import * as anchor from '@project-serum/anchor';

import { assert } from 'chai';
import { Program } from '@project-serum/anchor';

import { Connection, PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
    BulkAccountLoader,
	ClearingHouse,
	EventSubscriber,
	Order,
	OrderRecord,
    initialize,
    MultiConnection,
} from '../sdk/src';

import {
	mockUSDCMint,
	mockOracle,
	initializeQuoteAssetBank,
} from './testHelpers';

describe('multiConnection', () => {
	const provider = anchor.AnchorProvider.local();
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let adminClearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		const solUsd = await mockOracle(1);
		const periodicity = new BN(60 * 60); // 1 HOUR

		adminClearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeUserId: 0,
			marketIndexes: [new BN(0)],
			bankIndexes: [new BN(0)],
		});

		await adminClearingHouse.initialize(usdcMint.publicKey, true);
		await adminClearingHouse.subscribe();

		await initializeQuoteAssetBank(adminClearingHouse, usdcMint.publicKey);
		await adminClearingHouse.updateAuctionDuration(new BN(0), new BN(0));

		await adminClearingHouse.initializeMarket(
			solUsd,
			new BN(1000),
			new BN(1000),
			periodicity
		);
        await adminClearingHouse.fetchAccounts();
	});

	after(async () => {
		await adminClearingHouse.unsubscribe();
        await eventSubscriber.unsubscribe();
	});


	it('Can start ClearingHouse', async () => {
        const newConnection = provider.connection;
        const myConn = new MultiConnection([newConnection]);
        const bulkAccountLoader = new BulkAccountLoader(myConn, 'confirmed', 1000);
        const config = initialize({ env: 'devnet' });

        const clearingHouse = new ClearingHouse({
            connection: newConnection,
            wallet: provider.wallet,
            programID: new PublicKey(
                config.CLEARING_HOUSE_PROGRAM_ID
            ),
            env: 'devnet',
            accountSubscription: {
                type: 'polling',
                accountLoader: bulkAccountLoader,
            }
        });
        await clearingHouse.initializeUserAccount();

        await new Promise(resolve => setTimeout(resolve, 1000));

        if (!await clearingHouse.subscribe()) {
            throw new Error('Failed to subscribe to ClearingHouse');
        }

        // TODO: complete test

        // wait 5 seconds
        await new Promise(resolve => setTimeout(resolve, 5000));
        await clearingHouse.unsubscribe();

        return;
	});

});
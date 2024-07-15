import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	OracleSource,
	TestClient,
	getPythPullOraclePublicKey,
} from '../sdk/src';
import { TestBulkAccountLoader } from '../sdk/src/accounts/testBulkAccountLoader';
import { BankrunContextWrapper } from '../sdk/src/bankrun/bankrunConnection';
import { startAnchor } from 'solana-bankrun';
import { AccountInfo, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { DEFAULT_WORMHOLE_PROGRAM_ID } from '@pythnetwork/pyth-solana-receiver';
import { WORMHOLE_DATA } from './pythPullOracleData';
import { initializeQuoteSpotMarket, mockUSDCMint } from './testHelpers';

// set up account infos to load into banks client
const GUARDIAN_SET_ACCOUNT_INFO: AccountInfo<Buffer> = {
	executable: false,
	lamports: LAMPORTS_PER_SOL,
	owner: DEFAULT_WORMHOLE_PROGRAM_ID,
	rentEpoch: 0,
	data: Buffer.from(WORMHOLE_DATA, 'base64'),
};

const GUARDIAN_SET_KEY = new PublicKey(
	'5gxPdahvSzcKySxXxPuRXZZ9s6h8hZ88XDVKavWpaQGn'
);

describe('pyth pull oracles', () => {
	const chProgram = anchor.workspace.Drift as Program;

	let driftClient: TestClient;

	let bulkAccountLoader: TestBulkAccountLoader;

	let bankrunContextWrapper: BankrunContextWrapper;
	let usdcMint;

	const feedId =
		'0x2f2d17abbc1e781bd87b4a5d52c8b2856886f5c482fa3593cebf6795040ab0b6';
	const feedId2 =
		'0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221';

	let feedAddress: PublicKey;

	before(async () => {
		// use bankrun builtin function to start solana program test
		const context = await startAnchor(
			'',
			[
				{
					name: 'pyth_solana_receiver',
					programId: new PublicKey(
						'G6EoTTTgpkNBtVXo96EQp2m6uwwVh2Kt6YidjkmQqoha'
					),
				},
			],
			[
				// load account infos into banks client like this
				{
					address: GUARDIAN_SET_KEY,
					info: GUARDIAN_SET_ACCOUNT_INFO,
				},
			]
		);

		// wrap the context to use it with the test helpers
		bankrunContextWrapper = new BankrunContextWrapper(context);

		// don't use regular bulk account loader, use test
		bulkAccountLoader = new TestBulkAccountLoader(
			bankrunContextWrapper.connection,
			'processed',
			1
		);

		usdcMint = await mockUSDCMint(bankrunContextWrapper);

		const feedIdBuffer = Uint8Array.from(Buffer.from(feedId, 'hex'));
		feedAddress = getPythPullOraclePublicKey(chProgram.programId, feedIdBuffer);

		driftClient = new TestClient({
			// call toConnection to avoid annoying type error
			connection: bankrunContextWrapper.connection.toConnection(),
			// make sure to avoid regular `provider.X`, they don't show as errors
			wallet: bankrunContextWrapper.provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [],
			spotMarketIndexes: [0],
			subAccountIds: [], // make sure to add [] for subaccounts or client will gpa
			oracleInfos: [
				{
					publicKey: feedAddress,
					source: OracleSource.PYTH_PULL,
				},
			],
			// BANKRUN DOES NOT WORK WITH WEBSOCKET
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await driftClient.initialize(usdcMint.publicKey, true);
		await driftClient.subscribe();

		await initializeQuoteSpotMarket(driftClient, usdcMint.publicKey);
	});

	after(async () => {
		await driftClient.unsubscribe();
	});

	it('init feed', async () => {
		const txsig = await driftClient.initializePythPullOracle(feedId);

		console.log(txsig);

		const txsig2 = await driftClient.initializePythPullOracle(feedId2);

		console.log(txsig2);
	});

	it('post atomic', async () => {
		const vaa =
			'UE5BVQEAAAADuAEAAAAEDQCGP2Fjz2LFIX48Qqm/paFzO/iEtFgH5sC1FHhNroyIC2fuzsISzz9IHbvBrlknA0UvM8r9UHSvsAwaqzquhzFsAALnhRblTgAMLanjq38YctnwqDsdV39WviJ0QAnWgRn+a2i4ljPkbVQl1+MM47qcsua4+1L6jo8i3LPMivVx+HQgAQRRADMkx28oGLPnNZnaZp8wtsxckjtx1GvXi+l9d89Yu1DJnYEGkVF4TzZSKtIQe+5OoUPAaIpnEauGVe0AEeh7AAYzopa5UFEUji5zKjTRRUxlQWAWDq3LuGMeV7osio6L/jyD0jMxpYMR0r/dqIdUi2a4GP0uF15k9yFMkANh7OCRAAgb/WNBqaYjLjZsqRqEFKbG3ZVR2vS5ph7EO6D8TKP2gg3Mk3Mhyr2O21KAboy061vKPbHTjX1w3dq8ipnz6EacAQpOpdNfjx1LhMu7ZaMfSM6IFqHOZnQqGxQOQHwh5lAd50Vj8LVu3rng211UchelGHtROvhN1IapTkVSEhD0dbeeAQs+IYIUBk8EahKpPnD0hk6E2d8ge3gKDcgakWgDhRMunArMASyVWkWw0N3p9FvOobXg4V4L5Tim6L1AhHf5Rj0YAAxsygUAwlhGQPEThxT72eY0HVbi8C1LATsBXrW6jksUNTllCqWWbRwgwDSlgibrk05BKtO1pjFCjkWRZZ+TCvrsAA05LnYl0RwpRYUs31y5Lbk8mZHrFDj02MkTC05rGcjVzmddlNcj5/IIp8Hc44GJFZ4XZO3kx7jW3vuF6RQm6RPmAA6xLKcvzZllJT8kxn/LI4AYUuCIOVyLMG/kVodeXWkOKSrkXr0SNwMFsLfl9xvPk2dCa7SyicGwMTUfKP4P8cyeAQ9Q5G4EDpPCq/A0J3luHRoCnSDpCuCu4zTzESAmRe80aSwDl7tN4wSn369Nu4iD6JSyUx/y3bHF7BgvlyGfQYHjABCZpnivKtKFNYpaLR627OKG//Vv3zol7gdCoMOXRcIxLhwSuhn5QlVHgeoOrHiLtOBlTzpz4bwa8btRxvU43pCgABK2TIKVKUnv5OyTjkQh8N5IMpaRK83UH3hpvsJKejNpJQK2zR/WfCkrYjy6pYQfhenZYHi4GCMQ0ALSh9cojaDlAGaVh0wAAAAAABrhAfrtrFhR4yubI7X5QRqMK6xKrj7U3XuBHdGnLqSqcQAAAAAEHJOLAUFVV1YAAAAAAAknGqgAACcQdoC/4vcjI21wyoVC1q3FUZH0FpwBAFUALy0Xq7weeBvYe0pdUsiyhWiG9cSC+jWTzr9nlQQKsLYAAAAAAICwNAAAAAAAAS4k////+AAAAABmlYdMAAAAAGaVh0sAAAAAAH6C+QAAAAAAAPFsCz2Sz2/hyAOSwCA+M8lRiOs+jGuZp6wcFR4rTAFuR2bAYNycVYQFeCxlkQJrEKDSba6FxQXgPZ7wBb/43EHuHHKQaaGb3NVsxnHFnLHefZDbF235q+aRnadgJfm6gqckqb0IczoHBaSuyrVYfSEbPuyNjXE7V++G/OwwVrwQOWqD6ti/nzLgnQ+qCVpEBto25YvZQzkmfYMKg1tJepxs/Sbgyx2fayAJtK8pRlJIixSTRbLiQX408KCq/ElVNzOSqt6Aw1KrAg81sLzKSjMEqnhbdFxgSzqncj8kPFw=';
		await driftClient.postPythPullOracleUpdateAtomic(vaa, feedId);
	});

	it('post multi atomic', async () => {
		const vaa2 =
			'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';
		await driftClient.postMultiPythPullOracleUpdatesAtomic(vaa2, [
			feedId,
			feedId2,
		]);
	});
});

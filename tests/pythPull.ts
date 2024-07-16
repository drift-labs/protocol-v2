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

		const vaa2 =
			'UE5BVQEAAAADuAEAAAAEDQDc2hVEcIUrICFGaQq4RM0vRWvItSlrys95cDcrkEjO4zRUN58Is5F1wXnAU1rf5vyHsvzqpgiUFCxFtWvJwVDHAAKa8BkOZtLuMprcFVumuM9AvRfpeg0So44grSta3L/w61QyaXdz0wJzSwjmwrfD7rSJZTUOHKfQorKu3ZkxHToZAAOt57BA179w/ucYFiND/2kdJMWktWgSR2QjozplgkKRHQagS/ywGd6TFfm+DNA4BKYL22rmadKusbxjBcU22DPiAARq1QLTep9mlORm1IgN1ZzVhxkvkgi4WM5PEeJ6+I5TiQC7FKd856WvyP8atBUcKR15Lgz9ZE9DY2kF27Q+wFi2AAYqXgVPa/CpX15vrDvdBUh3SLi044teVClqeSQAMIXn7mPterNx3Q8zAp2zC4qjN8eMkiuowzgVYAPLbSojiqglAAr8gXKeRs/ShN8NAE1zF8E3oCTdprBuZF1ybMUc1kSgKzZZ12mMwbjZSF4Q44p3sqiavGpFlFjmcybDaUl8aWJ+AAvRxLxC3BT2A+0wJl2Ce3YLC4V8UbnqkCBuzC3h/lUxYl5Jq1m0VKGvtBLj53CTVbfoVWhCzACfYlK2kZBSC8KGAAxjGzNbgy2VneAvMRxti+WCzAez4r/hsXSZ2Wi49RVc52qRrCaVEJpkP99aiB5gOzNY4ng+rK+tk561mumezhNNAA1/bTfa/no9HZksi4NiMOVEOlx1ug8hghAm/r+KFlYX7nsUiUTdJCsDos7Y9zC+UqG1yHt0OE0RV+uRJkqasJgEAQ7GnDzVN7NEMq34GIL9Q8PUqaBRPDdjlVf14gFU1D6HLwBwVqBPHLwnr4GqSfcO+EMBgTNvPeqx+xWtCHcYtI74AA8N13C5+QTd4Qu+TPkpJIhVRv5O5z7j9MVVvfJpUVMORGdYEIUpXMArq4Zb70lMzoMcYCjBTbeNvxPn+HBtUUQZABCzDosCAHyr23dobNqgg8P7Z4LqGjnKWMJsbiKyewq+ng/8qWuZUO3KZ3glHJ+3KjrJgHYC+PLjIPUZnwrjFy3fABK2w/2CEkB9KSLkS6YDcp7R7QHIrZRWKUW1iQiXHtj16WOflrbPJGp2MOgbkrDrYQp4ipbbTzTladr38mmMGiZsAWaVwacAAAAAABrhAfrtrFhR4yubI7X5QRqMK6xKrj7U3XuBHdGnLqSqcQAAAAAEHPavAUFVV1YAAAAAAAknfhEAACcQgFOfLGKHbJbxauzziTnlt0Xlh1gBAFUAisDHD/9X6a799e30S1HWLC1DNlPLss9cwGuxFa8E0iEAAAAAVaqMxwAAAAAAGDsi////+AAAAABmlcGnAAAAAGaVwacAAAAAVbLTBgAAAAAAGJGeC2rbEc8RBavyZnHPH8c4HE1TFzMoiBlytoHGYH+/vEzCdYrfKt5KKrTHt3kKzcz3S++qH8IunSfjLrLACOU5cr56+tHHO9r8euqhuA3k1gr8WCE3SvRjWGztMqOxTby+WgR113+jEgTHM2sPzdhcQcl7i41YTAU73CQa0ctzW4doZ011mUudbbs35tRRYgGmY2HC3ezZp23NJXtPDPnl3GpFxEr6F/KfIS+/r3SfaCH7ixnUR2+sy2i15kUG29PznUmMPDqo2ROTdbW6KU/EkqlJeOlfRg6gJFNT2pw=';
		await driftClient.postPythPullOracleUpdateAtomic(vaa2, feedId2);
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

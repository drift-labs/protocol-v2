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
			'UE5BVQEAAAADuAEAAAAEDQD/qNivPFYJJLxpZyzzZS8JKC/O0BbxOqTFQVppy9g7qQJkv77jZzXliPlVp2pj/XpAc0sX4mK/bUgRbgy67HvxAQGeSJ70XMWkrcdLAM3nbtJqMcjtqbo1slYOWl+W44np1HwR78KI0urKeXihFGldwTW68bUKnCI9Ek/YOsLg3Vp1AAI1AUlwdaSuyC52dlxlNLK2y8RGrPVBgdIiDe6IGqYTzyjOhykRvJOJwKDKaXWlSXuuyKUPnK/4PnFXZjswysSKAANADeJPI+0DvqgkMMGG3TVQSrl7ZMmj7PE1/66JmPDOPUQSZrH0v8vGzWXnsvk3z12IK4EY+JXMoPQtm/OJAuSIAQSptxWe6WVS6bjAzEBdnZxhmf57U5qONCxTU9v948USURvfZ3Yd3C965oJFBCbp0SbRVtj3nu4qhoSx6rBIegFfAQZzNX2jolYLTMDJhP/iRdZU292Z8zIQQJPccYNrVbhdBE4qfkc6wxeBKflMjrqLg1/5HP3TpRsAhf2HBOX4jruVAAhAI7izWK+vwmv9jT28yRIVIhCxr/CAM1MoTUhj4KdXCzEt4FrEwK69YaR0lOHQPo4m0PLsUZc46E4x55/MLO+CAQqj8fBJAFDYfo/Z0/RReHTzJEwdXjw9ciFMNOcl5e1kCWCdgb6geBFWb+PVfypq0AjMnHshQWhVlMRQF+XKKReRAQvosFAt7QDGHeJunw46PFj25wm/5nvnX7EEmHsPF5mVqhAKocKX5gcTFJkZI4GJjJrIcbu8HDuSxnhG6OHD+mlBAQ7j7N1VGSdYPcCGWfx3iDSUmxXMxBYZDH9pE0TJ1t6eJh7RPa/L1bS+eNsr7/+dt7ZZxW1SJPHFWAut+x6XvHC+AQ8Qh/+11kbhge0VIvzX8NApMmWuiWYAK1gb1wslKjAM5h6GNJbPNC4w4o4VvDZjECbT4tNarIqeG/tMAJjLEg4iABBfPqaYYng2ySV12JA2/qSFuhHhy2NRlepLNHNJrBv4iQvidg04Dhncf3PkKrwA/wy6BayzhiubnRHxWCxmOauOARJoSack2B6Lz/5R/AmgOG6RVwL3nTDPcY5CRXMgDqCgKzJMayFMVa91Q+Te+kYEf0AzJiuMq1dHjeYn0sxBRmb7AWaVlrQAAAAAABrhAfrtrFhR4yubI7X5QRqMK6xKrj7U3XuBHdGnLqSqcQAAAAAEHK2eAUFVV1YAAAAAAAknNNgAACcQuiXIhu0Mf9L850nRrXpM008rwiUBAFUALy0Xq7weeBvYe0pdUsiyhWiG9cSC+jWTzr9nlQQKsLYAAAAAAH9bqQAAAAAAAUUb////+AAAAABmlZa0AAAAAGaVlrQAAAAAAH93kwAAAAAAAO6UCxGX7jL8qPen9cnaNiBqBuua/FpvAYFJzAw6g0NVO6KdKHi9akz0tOmEpVX3AKXtc2/5lGBqB5EA9hdBYEAQuxnJZhcXfE1z1s8VKN65sONovLhJLbgwxI4CRKYhCp551z7re8ZtO5iGERKqm98PBIcuP1ksBhdosyT63mddUuJYYPARfcLgF3Y8TIXUf8z3ahoWjdQaZNkoPpZ+l85qtgLWHnxG184jgQQ1oFORyCno97Z6GhlB1gwu5x2RikePbgfAVoDXXe4YBBtM7+/TDDF2qI3Pz3wdslw0dWw=';
		await driftClient.postMultiPythPullOracleUpdatesAtomic(vaa2, [
			feedId,
			feedId2,
		]);
	});
});

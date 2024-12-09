<div align="center">
  <img height="120x" src="https://uploads-ssl.webflow.com/611580035ad59b20437eb024/616f97a42f5637c4517d0193_Logo%20(1)%20(1).png" />

  <h1 style="margin-top:20px;">Drift Protocol v2</h1>

  <p>
    <a href="https://www.npmjs.com/package/@drift-labs/sdk"><img alt="SDK npm package" src="https://img.shields.io/npm/v/@drift-labs/sdk" /></a>
    <a href="https://drift-labs.github.io/protocol-v2/sdk/"><img alt="Docs" src="https://img.shields.io/badge/docs-tutorials-blueviolet" /></a>
    <a href="https://discord.com/channels/849494028176588802/878700556904980500"><img alt="Discord Chat" src="https://img.shields.io/discord/889577356681945098?color=blueviolet" /></a>
    <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/github/license/project-serum/anchor?color=blueviolet" /></a>
  </p>
</div>

## Installation

```
npm i @drift-labs/sdk
```

## Getting Started

*Start here if you're integrating with Drift!*

- [Drift v2-teacher + API Docs](https://drift-labs.github.io/v2-teacher/)
	- Docs and examples for using the SDK in Typescript and Python
	- Useful concepts and examples when integrating Drift
	- Docs for Drift's "Data API"
- [Typescript API docs](https://drift-labs.github.io/protocol-v2/sdk/)
	- JSDoc automated documentation for the Drift v2 Typescript SDK
- [Drift docs](https://docs.drift.trade/)
	- Comprehensive universal docs for Drift

---

The below is a light overview of using Solana and Drift's typescript sdk. If you want comprehensive docs with examples of how to integrate with Drift you should use the [v2-teacher docs](https://drift-labs.github.io/v2-teacher/).

### Setting up a wallet for your program

```bash
# Generate a keypair
solana-keygen new

# Get the pubkey for the new wallet (You will need to send USDC to this address to Deposit into Drift (only on mainnet - devnet has a faucet for USDC))
solana address

# Put the private key into your .env to be used by your bot
cd {projectLocation}
echo BOT_PRIVATE_KEY=`cat ~/.config/solana/id.json` >> .env
```

## Concepts

### BN / Precision

The Drift SDK uses BigNum (BN), using [this package](https://github.com/indutny/bn.js/), to represent numerical values. This is because Solana tokens tend to use levels of precision which are too precise for standard Javascript floating point numbers to handle. All numbers in BN are represented as integers, and we will often denote the `precision` of the number so that it can be converted back down to a regular number.

```bash
Example:
a BigNum: 10,500,000, with precision 10^6, is equal to 10.5 because 10,500,000 / 10^6 = 10.5.
```

The Drift SDK uses some common precisions, which are available as constants to import from the SDK.

| Precision Name        | Value |
| --------------------- | ----- |
| FUNDING_RATE_BUFFER   | 10^3  |
| QUOTE_PRECISION       | 10^6  |
| PEG_PRECISION         | 10^6  |
| PRICE_PRECISION       | 10^6  |
| AMM_RESERVE_PRECISION | 10^9  |
| BASE_PRECISION        | 10^9  |

**Important Note for BigNum division**

Because BN only supports integers, you need to be conscious of the numbers you are using when dividing. BN will return the floor when using the regular division function; if you want to get the exact division, you need to add the modulus of the two numbers as well. There is a helper function `convertToNumber` in the SDK which will do this for you.

```typescript
import {convertToNumber} from @drift-labs/sdk

// Gets the floor value
new BN(10500).div(new BN(1000)).toNumber(); // = 10

// Gets the exact value
new BN(10500).div(new BN(1000)).toNumber() + BN(10500).mod(new BN(1000)).toNumber(); // = 10.5

// Also gets the exact value
convertToNumber(new BN(10500), new BN(1000)); // = 10.5
```

## Examples

### Setting up an account and making a trade

```typescript
import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider } from '@coral-xyz/anchor';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	calculateReservePrice,
	DriftClient,
	User,
	initialize,
	PositionDirection,
	convertToNumber,
	calculateTradeSlippage,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	Wallet,
	PerpMarkets,
	BASE_PRECISION,
	getMarketOrderParams,
	BulkAccountLoader,
	BN,
	calculateBidAskPrice,
	getMarketsAndOraclesForSubscription,
	calculateEstimatedPerpEntryPrice,
} from '../sdk';

export const getTokenAddress = (
	mintAddress: string,
	userPubKey: string
): Promise<PublicKey> => {
	return getAssociatedTokenAddress(
		new PublicKey(mintAddress),
		new PublicKey(userPubKey)
	);
};

const main = async () => {
	const env = 'devnet';
	// const env = 'mainnet-beta';

	// Initialize Drift SDK
	const sdkConfig = initialize({ env });

	// Set up the Wallet and Provider
	if (!process.env.ANCHOR_WALLET) {
		throw new Error('ANCHOR_WALLET env var must be set.');
	}

	if (!process.env.ANCHOR_PROVIDER_URL) {
		throw new Error('ANCHOR_PROVIDER_URL env var must be set.');
	}

	const provider = anchor.AnchorProvider.local(
		process.env.ANCHOR_PROVIDER_URL,
		{
			preflightCommitment: 'confirmed',
			skipPreflight: false,
			commitment: 'confirmed',
		}
	);
	// Check SOL Balance
	const lamportsBalance = await provider.connection.getBalance(
		provider.wallet.publicKey
	);
	console.log(
		provider.wallet.publicKey.toString(),
		env,
		'SOL balance:',
		lamportsBalance / 10 ** 9
	);

	// Misc. other things to set up
	const usdcTokenAddress = await getTokenAddress(
		sdkConfig.USDC_MINT_ADDRESS,
		provider.wallet.publicKey.toString()
	);

	// Set up the Drift Client
	const driftPublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);
	const bulkAccountLoader = new BulkAccountLoader(
		provider.connection,
		'confirmed',
		1000
	);
	const driftClient = new DriftClient({
		connection: provider.connection,
		wallet: provider.wallet,
		programID: driftPublicKey,
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});
	await driftClient.subscribe();

	console.log('subscribed to driftClient');

	// Set up user client
	const user = new User({
		driftClient: driftClient,
		userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
	});

	//// Check if user account exists for the current wallet
	const userAccountExists = await user.exists();

	if (!userAccountExists) {
		console.log(
			'initializing to',
			env,
			' drift account for',
			provider.wallet.publicKey.toString()
		);

		//// Create a Drift V2 account by Depositing some USDC ($10,000 in this case)
		const depositAmount = new BN(10000).mul(QUOTE_PRECISION);
		await driftClient.initializeUserAccountAndDepositCollateral(
			depositAmount,
			await getTokenAddress(
				usdcTokenAddress.toString(),
				provider.wallet.publicKey.toString()
			)
		);
	}

	await user.subscribe();

	// Get current price
	const solMarketInfo = PerpMarkets[env].find(
		(market) => market.baseAssetSymbol === 'SOL'
	);

	const marketIndex = solMarketInfo.marketIndex;

	// Get vAMM bid and ask price
	const [bid, ask] = calculateBidAskPrice(
		driftClient.getPerpMarketAccount(marketIndex).amm,
		driftClient.getOracleDataForPerpMarket(marketIndex)
	);

	const formattedBidPrice = convertToNumber(bid, PRICE_PRECISION);
	const formattedAskPrice = convertToNumber(ask, PRICE_PRECISION);

	console.log(
		env,
		`vAMM bid: $${formattedBidPrice} and ask: $${formattedAskPrice}`
	);

	const solMarketAccount = driftClient.getPerpMarketAccount(
		solMarketInfo.marketIndex
	);
	console.log(env, `Placing a 1 SOL-PERP LONG order`);

	const txSig = await driftClient.placePerpOrder(
		getMarketOrderParams({
			baseAssetAmount: new BN(1).mul(BASE_PRECISION),
			direction: PositionDirection.LONG,
			marketIndex: solMarketAccount.marketIndex,
		})
	);
	console.log(
		env,
		`Placed a 1 SOL-PERP LONG order. Tranaction signature: ${txSig}`
	);
};

main();
```

## License

Drift Protocol v2 is licensed under [Apache 2.0](./LICENSE).

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in Drift SDK by you, as defined in the Apache-2.0 license, shall be
licensed as above, without any additional terms or conditions.


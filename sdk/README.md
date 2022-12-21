<div align="center">
  <img height="120x" src="https://uploads-ssl.webflow.com/611580035ad59b20437eb024/616f97a42f5637c4517d0193_Logo%20(1)%20(1).png" />

  <h1 style="margin-top:20px;">Drift Protocol v2</h1>

  <p>
    <a href="https://www.npmjs.com/package/@drift-labs/sdk"><img alt="SDK npm package" src="https://img.shields.io/npm/v/@drift-labs/sdk" /></a>
    <a href="https://drift-labs.github.io/protocol-v1/sdk/"><img alt="Docs" src="https://img.shields.io/badge/docs-tutorials-blueviolet" /></a>
    <a href="https://discord.com/channels/849494028176588802/878700556904980500"><img alt="Discord Chat" src="https://img.shields.io/discord/889577356681945098?color=blueviolet" /></a>
    <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/github/license/project-serum/anchor?color=blueviolet" /></a>
  </p>
</div>

# Drift Protocol v2

This repository provides open source access to Drift's Typescript SDK, Solana Programs, and more.

# SDK Guide

The technical documentation for the SDK can be found [here](https://drift-labs.github.io/protocol-v2/sdk/), and you can visit Drift's general purpose documentation [here](https://docs.drift.trade/sdk-documentation).

## Installation

```
npm i @drift-labs/sdk
```

## Getting Started

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

**Important Note for BigNum division**

Because BN only supports integers, you need to be conscious of the numbers you are using when dividing. BN will return the floor when using the regular division function; if you want to get the exact divison, you need to add the modulus of the two numbers as well. There is a helper function `convertToNumber` in the SDK which will do this for you.

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
import { BN, Provider } from '@project-serum/anchor';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
	calculateReservePrice,
	DriftClient,
	User,
	initialize,
	Markets,
	PositionDirection,
	convertToNumber,
	calculateTradeSlippage,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	Wallet,
} from '@drift-labs/sdk';

export const getTokenAddress = (
	mintAddress: string,
	userPubKey: string
): Promise<PublicKey> => {
	return Token.getAssociatedTokenAddress(
		new PublicKey(`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`),
		TOKEN_PROGRAM_ID,
		new PublicKey(mintAddress),
		new PublicKey(userPubKey)
	);
};

const main = async () => {
	// Initialize Drift SDK
	const sdkConfig = initialize({ env: 'devnet' });

	// Set up the Wallet and Provider
	const privateKey = process.env.BOT_PRIVATE_KEY; // stored as an array string
	const keypair = Keypair.fromSecretKey(
		Uint8Array.from(JSON.parse(privateKey))
	);
	const wallet = new Wallet(keypair);

	// Set up the Connection
	const rpcAddress = process.env.RPC_ADDRESS; // can use: https://api.devnet.solana.com for devnet; https://api.mainnet-beta.solana.com for mainnet;
	const connection = new Connection(rpcAddress);

	// Set up the Provider
	const provider = new Provider(connection, wallet, Provider.defaultOptions());

	// Check SOL Balance
	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	console.log('SOL balance:', lamportsBalance / 10 ** 9);

	// Misc. other things to set up
	const usdcTokenAddress = await getTokenAddress(
		sdkConfig.USDC_MINT_ADDRESS,
		wallet.publicKey.toString()
	);

	// Set up the Drift Client
	const driftClientPublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);
	const driftClient = DriftClient.from(
		connection,
		provider.wallet,
		driftClientPublicKey
	);
	await driftClient.subscribe();

	// Set up Clearing House user client
	const user = User.from(driftClient, wallet.publicKey);

	//// Check if clearing house account exists for the current wallet
	const userAccountExists = await user.exists();

	if (!userAccountExists) {
		//// Create a Clearing House account by Depositing some USDC ($10,000 in this case)
		const depositAmount = new BN(10000).mul(QUOTE_PRECISION);
		await driftClient.initializeUserAccountAndDepositCollateral(
			depositAmount,
			await getTokenAddress(
				usdcTokenAddress.toString(),
				wallet.publicKey.toString()
			)
		);
	}

	await user.subscribe();

	// Get current price
	const solMarketInfo = Markets.find(
		(market) => market.baseAssetSymbol === 'SOL'
	);

	const currentMarketPrice = calculateReservePrice(
		driftClient.getMarket(solMarketInfo.marketIndex)
	);

	const formattedPrice = convertToNumber(currentMarketPrice, PRICE_PRECISION);

	console.log(`Current Market Price is $${formattedPrice}`);

	// Estimate the slippage for a $5000 LONG trade
	const solMarketAccount = driftClient.getMarket(solMarketInfo.marketIndex);

	const slippage = convertToNumber(
		calculateTradeSlippage(
			PositionDirection.LONG,
			new BN(5000).mul(QUOTE_PRECISION),
			solMarketAccount
		)[0],
		PRICE_PRECISION
	);

	console.log(
		`Slippage for a $5000 LONG on the SOL market would be $${slippage}`
	);

	// Make a $5000 LONG trade
	await driftClient.openPosition(
		PositionDirection.LONG,
		new BN(5000).mul(QUOTE_PRECISION),
		solMarketInfo.marketIndex
	);
	console.log(`LONGED $5000 worth of SOL`);

	// Reduce the position by $2000
	await driftClient.openPosition(
		PositionDirection.SHORT,
		new BN(2000).mul(QUOTE_PRECISION),
		solMarketInfo.marketIndex
	);

	// Close the rest of the position
	await driftClient.closePosition(solMarketInfo.marketIndex);
};

main();
```

## License

Drift Protocol v1 is licensed under [Apache 2.0](./LICENSE).

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in Drift SDK by you, as defined in the Apache-2.0 license, shall be
licensed as above, without any additional terms or conditions.


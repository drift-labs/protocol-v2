<div align="center">
  <img height="170x" src="https://uploads-ssl.webflow.com/611580035ad59b20437eb024/616f97a42f5637c4517d0193_Logo%20(1)%20(1).png" />

  <h1 style="margin-top:10px;">Drift SDK</h1>

  <p>
  <!-- // todo -->
    <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/npm/v/@drift/sdk" /></a>
    <!-- // todo -->
    <a href="https://sdk.drift.trade"><img alt="Tutorials" src="https://img.shields.io/badge/docs-tutorials-blueviolet" /></a>
    <a href="https://discord.com/channels/849494028176588802/878700556904980500"><img alt="Discord Chat" src="https://img.shields.io/discord/889577356681945098?color=blueviolet" /></a>
    <!-- // todo -->
    <a href="https://opensource.org/licenses/Apache-2.0"><img alt="License" src="https://img.shields.io/github/license/project-serum/anchor?color=blueviolet" /></a>
  </p>
</div>

## Installation

```bash
npm i @drift/sdk 
```

## Getting Started

### Setting up a wallet for your program
```bash
// TODO: How to generate a wallet keypair
// TODO: How to get the pubkey to send some USDC to (for mainnet)
// TODO: How to put the private key into the .env file for the user's program
```

## Examples
### Setting up an account and making a trade

```typescript
import {
	BN,
	ClearingHouse,
	ClearingHouseUser,
	initialize,
	USDC_PRECISION,
} from '@moet/sdk';
import { Provider, Wallet } from '@project-serum/anchor';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

//// TODO: make this neater ... should we add this method to the SDK?
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
	const privateKey = process.env.BOT_PRIVATE_KEY;
	const keypair = Keypair.fromSecretKey(
		Uint8Array.from(privateKey.split(',').map((val) => Number(val)))
	);
	const wallet = new Wallet(keypair);

	// Set up the Connection
	const rpcAddress = process.env.RPC_ADDRESS; // If you don't have your own RPC, you can use: https://api.devnet.solana.com for devnet or https://api.mainnet-beta.solana.com for mainnet instead
	const connection = new Connection(rpcAddress);

	// Set up the Provider
	const provider = new Provider(connection, wallet, Provider.defaultOptions());

	// Misc. other things to set up
	const usdcTokenAddress = await getTokenAddress(
		sdkConfig.USDC_MINT_ADDRESS,
		wallet.publicKey.toString()
	);

	// Set up the Drift Clearing House
	const clearingHousePublicKey = new PublicKey(
		sdkConfig.CLEARING_HOUSE_PROGRAM_ID
	);
	const clearingHouse = ClearingHouse.from(
		connection,
		provider.wallet,
		clearingHousePublicKey
	);
	await clearingHouse.subscribe();

	// Set up Clearing House user client
	const user = ClearingHouseUser.from(clearingHouse, wallet.publicKey);

	//// Check if clearing house account exists for the current wallet
	const userAccountExists = await user.exists();

	if (!userAccountExists) {
		//// Create a Clearing House account by Depositing some USDC ($10,000 in this case)
		const depositAmount = new BN(10000).mul(USDC_PRECISION);
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			depositAmount,
			await getTokenAddress(
				usdcTokenAddress.toString(),
				wallet.publicKey.toString()
			)
		);
	}

	await user.subscribe();

	// Get recent trades
    //// TODO

	// Get current price
    //// TODO

	// Make a trade
	//// TODO
};

main();
```

## License
// TODO
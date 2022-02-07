#!/usr/bin/env node
import { Command, OptionValues, program } from 'commander';
const promptly = require('promptly');
const colors = require('colors');
import os from 'os';
import fs from 'fs';
import log from 'loglevel';
import {
	Admin,
	ClearingHouseUser,
	initialize,
	Markets,
	Wallet,
} from '@drift-labs/sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { BN } from '@drift-labs/sdk';
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	Token,
	TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

log.setLevel(log.levels.INFO);

function commandWithDefaultOption(commandName: string): Command {
	return program
		.command(commandName)
		.option('-e, --env <env>', 'environment e.g devnet, mainnet-beta')
		.option('-k, --keypair <path>', 'Solana wallet')
		.option('-u, --url <url>', 'rpc url e.g. https://api.devnet.solana.com');
}

export function loadKeypair(keypairPath: string): Keypair {
	if (!keypairPath || keypairPath == '') {
		throw new Error('Keypair is required!');
	}
	const loaded = Keypair.fromSecretKey(
		new Uint8Array(JSON.parse(fs.readFileSync(keypairPath).toString()))
	);
	log.info(`wallet public key: ${loaded.publicKey}`);
	return loaded;
}

function adminFromOptions(options: OptionValues): Admin {
	let { env, keypair, url } = options;
	const config = getConfig();
	if (!env) {
		env = config.env;
	}
	log.info(`env: ${env}`);
	const sdkConfig = initialize({ env: env });

	if (!url) {
		url = config.url;
	}
	log.info(`url: ${url}`);
	const connection = new Connection(url);

	if (!keypair) {
		keypair = config.keypair;
	}
	const wallet = new Wallet(loadKeypair(keypair));

	return Admin.from(
		connection,
		wallet,
		new PublicKey(sdkConfig.CLEARING_HOUSE_PROGRAM_ID)
	);
}

async function wrapActionInAdminSubscribeUnsubscribe(
	options: OptionValues,
	action: (admin: Admin) => Promise<void>
): Promise<void> {
	const admin = adminFromOptions(options);
	log.info(`ClearingHouse subscribing`);
	await admin.subscribe();
	log.info(`ClearingHouse subscribed`);

	try {
		await action(admin);
	} catch (e) {
		log.error(e);
	}

	log.info(`ClearingHouse unsubscribing`);
	await admin.unsubscribe();
	log.info(`ClearingHouse unsubscribed`);
}

async function wrapActionInUserSubscribeUnsubscribe(
	options: OptionValues,
	action: (user: ClearingHouseUser) => Promise<void>
): Promise<void> {
	const admin = adminFromOptions(options);
	log.info(`ClearingHouse subscribing`);
	await admin.subscribe();
	log.info(`ClearingHouse subscribed`);
	const clearingHouseUser = ClearingHouseUser.from(
		admin,
		admin.wallet.publicKey
	);
	log.info(`User subscribing`);
	await clearingHouseUser.subscribe();
	log.info(`User subscribed`);

	try {
		await action(clearingHouseUser);
	} catch (e) {
		log.error(e);
	}

	log.info(`User unsubscribing`);
	await clearingHouseUser.unsubscribe();
	log.info(`User unsubscribed`);

	log.info(`ClearingHouse unsubscribing`);
	await admin.unsubscribe();
	log.info(`ClearingHouse unsubscribed`);
}

function logError(msg: string) {
	log.error(colors.red(msg));
}

function marketIndexFromSymbol(symbol: string): BN {
	const market = Markets.filter(
		(market) => market.baseAssetSymbol === symbol
	)[0];
	if (!market) {
		const msg = `Could not find market index for ${symbol}`;
		logError(msg);
		throw Error(msg);
	}
	return market.marketIndex;
}

commandWithDefaultOption('initialize')
	.argument('<collateral mint>', 'The collateral mint')
	.argument(
		'<admin controls prices>',
		'Whether the admin should control prices'
	)
	.action(
		async (collateralMint, adminControlsPrices, options: OptionValues) => {
			await wrapActionInAdminSubscribeUnsubscribe(
				options,
				async (admin: Admin) => {
					log.info(`collateralMint: ${collateralMint}`);
					log.info(`adminControlsPrices: ${adminControlsPrices}`);
					const collateralMintPublicKey = new PublicKey(collateralMint);
					log.info(`ClearingHouse initializing`);
					await admin.initialize(collateralMintPublicKey, adminControlsPrices);
				}
			);
		}
	);

commandWithDefaultOption('initialize-market')
	.argument(
		'<market index>',
		'Where the market will be initialized in the markets account'
	)
	.argument('<price oracle>', 'The public key for the oracle')
	.argument('<base asset reserve>', 'AMM base asset reserve')
	.argument('<quote asset reserve>', 'AMM quote asset reserve')
	.argument('<periodicity>', 'AMM quote asset reserve')
	.argument('<peg multiplier>', 'AMM peg multiplier')
	.action(
		async (
			marketIndex,
			priceOracle,
			baseAssetReserve,
			quoteAssetReserve,
			periodicity,
			pegMultiplier,
			options: OptionValues
		) => {
			await wrapActionInAdminSubscribeUnsubscribe(
				options,
				async (admin: Admin) => {
					log.info(`marketIndex: ${marketIndex}`);
					marketIndex = new BN(marketIndex);
					log.info(`priceOracle: ${priceOracle}`);
					priceOracle = new PublicKey(priceOracle);
					log.info(`baseAssetReserve: ${baseAssetReserve}`);
					baseAssetReserve = new BN(baseAssetReserve);
					log.info(`quoteAssetReserve: ${quoteAssetReserve}`);
					quoteAssetReserve = new BN(quoteAssetReserve);
					log.info(`periodicity: ${periodicity}`);
					periodicity = new BN(periodicity);
					log.info(`pegMultiplier: ${pegMultiplier}`);
					pegMultiplier = new BN(pegMultiplier);
					log.info(`Initializing market`);
					await admin.initializeMarket(
						marketIndex,
						priceOracle,
						baseAssetReserve,
						quoteAssetReserve,
						periodicity,
						pegMultiplier
					);
				}
			);
		}
	);

commandWithDefaultOption('update-discount-mint')
	.argument('<discount mint>', 'New discount mint')
	.action(async (discountMint, options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				log.info(`discountMint: ${discountMint}`);
				discountMint = new PublicKey(discountMint);
				await admin.updateDiscountMint(discountMint);
			}
		);
	});

commandWithDefaultOption('increase-k')
	.argument('<market>', 'The market to adjust k for')
	.argument('<numerator>', 'Numerator to multiply k by')
	.argument('<denominator>', 'Denominator to divide k by')
	.option('--force', 'Skip percent change check')
	.action(async (market, numerator, denominator, options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				log.info(`market: ${market}`);
				log.info(`numerator: ${numerator}`);
				log.info(`denominator: ${denominator}`);
				market = marketIndexFromSymbol(market);
				numerator = new BN(numerator);
				denominator = new BN(denominator);

				if (numerator.lt(denominator)) {
					logError('To increase k, numerator must be larger than denominator');
					return;
				}

				const percentChange = Math.abs(
					(numerator.toNumber() / denominator.toNumber()) * 100 - 100
				);
				if (percentChange > 10 && options.force !== true) {
					logError(
						`Specified input would lead to ${percentChange.toFixed(2)}% change`
					);
					return;
				}

				const answer = await promptly.prompt(
					`You are increasing k by ${percentChange}%. Are you sure you want to do this? y/n`
				);
				if (answer !== 'y') {
					log.info('Canceling');
					return;
				}

				const amm = admin.getMarketsAccount().markets[market.toNumber()].amm;
				const oldSqrtK = amm.sqrtK;
				log.info(`Current sqrt k: ${oldSqrtK.toString()}`);

				const newSqrtK = oldSqrtK.mul(numerator).div(denominator);
				log.info(`New sqrt k: ${newSqrtK.toString()}`);

				log.info(`Updating K`);
				await admin.updateK(newSqrtK, market);
				log.info(`Updated K`);
			}
		);
	});

commandWithDefaultOption('decrease-k')
	.argument('<market>', 'The market to adjust k for')
	.argument('<numerator>', 'Numerator to multiply k by')
	.argument('<denominator>', 'Denominator to divide k by')
	.option('--force', 'Skip percent change check')
	.action(async (market, numerator, denominator, options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				log.info(`market: ${market}`);
				log.info(`numerator: ${numerator}`);
				log.info(`denominator: ${denominator}`);
				market = marketIndexFromSymbol(market);
				numerator = new BN(numerator);
				denominator = new BN(denominator);

				if (numerator.gt(denominator)) {
					logError('To decrease k, numerator must be less than denominator');
					return;
				}

				const percentChange = Math.abs(
					(numerator.toNumber() / denominator.toNumber()) * 100 - 100
				);
				if (percentChange > 2) {
					logError(
						`Specified input would lead to ${percentChange.toFixed(2)}% change`
					);
					return;
				}

				const answer = await promptly.prompt(
					`You are decreasing k by ${percentChange}%. Are you sure you want to do this? y/n`
				);
				if (answer !== 'y' && options.force !== true) {
					log.info('Canceling');
					return;
				}

				const amm = admin.getMarketsAccount().markets[market.toNumber()].amm;
				const oldSqrtK = amm.sqrtK;
				log.info(`Current sqrt k: ${oldSqrtK.toString()}`);

				const newSqrtK = oldSqrtK.mul(numerator).div(denominator);
				log.info(`New sqrt k: ${newSqrtK.toString()}`);

				log.info(`Updating K`);
				await admin.updateK(newSqrtK, market);
				log.info(`Updated K`);
			}
		);
	});

commandWithDefaultOption('repeg')
	.argument('<market>', 'The market to adjust k for')
	.argument('<peg>', 'New Peg')
	.action(async (market, peg, options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				log.info(`market: ${market}`);
				log.info(`peg: ${peg}`);
				market = marketIndexFromSymbol(market);
				peg = new BN(peg);

				const amm = admin.getMarketsAccount().markets[market.toNumber()].amm;
				const oldPeg = amm.pegMultiplier;
				log.info(`Current peg: ${oldPeg.toString()}`);

				log.info(`Updating peg`);
				await admin.repegAmmCurve(peg, market);
				log.info(`Updated peg`);
			}
		);
	});

commandWithDefaultOption('pause-exchange').action(
	async (options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				const answer = await promptly.prompt(
					`Are you sure you want to 'pause' the exchange? y/n`
				);
				if (answer !== 'y') {
					log.info('Canceling');
					return;
				}
				await admin.updateExchangePaused(true);
				log.info(`Exchange was paused`);
			}
		);
	}
);

commandWithDefaultOption('unpause-exchange').action(
	async (options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				const answer = await promptly.prompt(
					`Are you sure you want to 'unpause' the exchange? y/n`
				);
				if (answer !== 'y') {
					log.info('Canceling');
					return;
				}
				await admin.updateExchangePaused(false);
				log.info(`Exchange was unpaused`);
			}
		);
	}
);

commandWithDefaultOption('pause-funding').action(
	async (options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				const answer = await promptly.prompt(
					`Are you sure you want to 'pause' funding? y/n`
				);
				if (answer !== 'y') {
					log.info('Canceling');
					return;
				}
				await admin.updateFundingPaused(true);
				log.info(`Funding was paused`);
			}
		);
	}
);

commandWithDefaultOption('unpause-funding').action(
	async (options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				const answer = await promptly.prompt(
					`Are you sure you want to 'unpause' funding? y/n`
				);
				if (answer !== 'y') {
					log.info('Canceling');
					return;
				}
				await admin.updateFundingPaused(false);
				log.info(`Funding was unpaused`);
			}
		);
	}
);

commandWithDefaultOption('update-oracle-twap')
	.argument('<market>', 'The market to update oracle twap for')
	.action(async (market, options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				log.info(`market: ${market}`);
				market = marketIndexFromSymbol(market);

				log.info(`Updating amm oracle twap`);
				await admin.updateAmmOracleTwap(market);
				log.info(`Updated oracle twap`);
			}
		);
	});

commandWithDefaultOption('reset-oracle-twap')
	.argument('<market>', 'The market to reset oracle twap for')
	.action(async (market, options: OptionValues) => {
		await wrapActionInAdminSubscribeUnsubscribe(
			options,
			async (admin: Admin) => {
				log.info(`market: ${market}`);
				market = marketIndexFromSymbol(market);

				log.info(`Resetting amm oracle twap`);
				await admin.resetAmmOracleTwap(market);
				log.info(`Reset oracle twap`);
			}
		);
	});

commandWithDefaultOption('deposit')
	.argument('<amount>', 'The amount to deposit')
	.action(async (amount, options: OptionValues) => {
		await wrapActionInUserSubscribeUnsubscribe(
			options,
			async (user: ClearingHouseUser) => {
				log.info(`amount: ${amount}`);
				amount = new BN(amount);

				const associatedTokenPublicKey = await Token.getAssociatedTokenAddress(
					ASSOCIATED_TOKEN_PROGRAM_ID,
					TOKEN_PROGRAM_ID,
					user.clearingHouse.getStateAccount().collateralMint,
					user.authority
				);

				await user.clearingHouse.depositCollateral(
					amount,
					associatedTokenPublicKey
				);
			}
		);
	});

function getConfigFileDir(): string {
	return os.homedir() + `/.config/drift-v1`;
}

function getConfigFilePath(): string {
	return `${getConfigFileDir()}/config.json`;
}

function getConfig() {
	if (!fs.existsSync(getConfigFilePath())) {
		console.error('drfit-v1 config does not exit. Run `drift-v1 config init`');
		return;
	}

	return JSON.parse(fs.readFileSync(getConfigFilePath(), 'utf8'));
}

const config = program.command('config');
config.command('init').action(async () => {
	const defaultConfig = {
		env: 'devnet',
		url: 'https://api.devnet.solana.com',
		keypair: `${os.homedir()}/.config/solana/id.json`,
	};

	const dir = getConfigFileDir();
	if (!fs.existsSync(getConfigFileDir())) {
		fs.mkdirSync(dir, { recursive: true });
	}

	fs.writeFileSync(getConfigFilePath(), JSON.stringify(defaultConfig));
});

config
	.command('set')
	.argument('<key>', 'the config key e.g. env, url, keypair')
	.argument('<value>')
	.action(async (key, value) => {
		if (key !== 'env' && key !== 'url' && key !== 'keypair') {
			console.error(`Key must be env, url or keypair`);
			return;
		}

		const config = JSON.parse(fs.readFileSync(getConfigFilePath(), 'utf8'));
		config[key] = value;
		fs.writeFileSync(getConfigFilePath(), JSON.stringify(config));
	});

config.command('get').action(async () => {
	const config = getConfig();
	console.log(JSON.stringify(config, null, 4));
});

program.parse(process.argv);

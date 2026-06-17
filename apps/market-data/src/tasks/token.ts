import { batchArray, logger, sleep } from '@backend/common';
import { StatsCacheRepository } from '@backend/redis';
import { AccountLayout, getAssociatedTokenAddress } from '@solana/spl-token';
import { AccountInfo, Connection } from '@solana/web3.js';
import { BigNum, PublicKey } from '@velocity-exchange/sdk';
import axios from 'axios';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { Scheduler } from '../services/scheduler';

dayjs.extend(utc);

const { setTokenStats } = StatsCacheRepository();
const DRIFT_TOKEN_TOTAL_SUPPLY = 1e9;
const DRIFT_TOKEN_PRECISION = 6;
const DRIFT_TOKEN_MINT = 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7';
const DRIFT_TOKEN_MINT_PUBKEY = new PublicKey(DRIFT_TOKEN_MINT);
const MAGNA_API_KEY = process.env.MAGNA_API_KEY || '';
const MAGNA_TOKEN_ID = 'c6112360-37ad-49a9-a938-70f357ef0d74';
const TREASURY_BUYBACK_AMOUNT = 2435863; // Figure from George

const magnaClient = axios.create({
	headers: {
		'Content-Type': 'application/json',
		'x-magna-api-token': MAGNA_API_KEY,
	},
});

interface MagnaSummaryResponse {
	isProcessed: boolean;
	result: {
		totalSupply: string;
		totalReceived: string;
		totalAllocationAmount: string;
		totalAllocationCount: number;
		funded: string;
	};
}

/**
 * Fetches the magna locked supply by calculating totalAllocationAmount - unlockedSupply
 * Makes requests in parallel for efficiency
 * @returns Promise<{totalAllocationAmount: number, unlockedSupply: number, lockedSupply: number}> - The locked supply data
 */
async function getMagnaLockedSupply(): Promise<{
	totalAllocationAmount: number;
	unlockedSupply: number;
	lockedSupply: number;
}> {
	try {
		const unlockedSupplyResponse = await magnaClient.get<string>(
			`https://app.magna.so/api/external/v1/tokens/${MAGNA_TOKEN_ID}/unlocked-supply?id=${MAGNA_TOKEN_ID}`
		);

		const data = unlockedSupplyResponse.data;
		const unlockedSupply = parseFloat(data);

		const summary = await magnaClient.get<MagnaSummaryResponse>(
			`https://app.magna.so/api/external/v1/tokens/${MAGNA_TOKEN_ID}/summary`
		);

		const totalAllocationAmount = parseFloat(summary.data.result.totalAllocationAmount);
		const lockedSupply = totalAllocationAmount - unlockedSupply;

		return {
			totalAllocationAmount,
			unlockedSupply,
			lockedSupply,
		};
	} catch (error) {
		logger.error(`Error calculating magna locked supply: ${error}`);
		throw error;
	}
}

/**
 * Gets the remaining locked DRIFT amount based on the nearest past date
 */
function getMulticoinLockedAmount(): number {
	const vestingEntries = [
		{ date: '2025-06-16', remaining: 41013896 },
		{ date: '2025-07-16', remaining: 37285360 },
		{ date: '2025-08-16', remaining: 33556824 },
		{ date: '2025-09-16', remaining: 29828288 },
		{ date: '2025-10-16', remaining: 26099752 },
		{ date: '2025-11-16', remaining: 22371216 },
		{ date: '2025-12-16', remaining: 18642680 },
		{ date: '2026-01-16', remaining: 14914144 },
		{ date: '2026-02-16', remaining: 11185608 },
		{ date: '2026-03-16', remaining: 7457072 },
		{ date: '2026-04-16', remaining: 3728536 },
		{ date: '2026-05-16', remaining: 0 },
	];

	const now = dayjs.utc();

	// Find entries where the date is in the past (or equal to today)
	const pastEntries = vestingEntries.filter((entry) => dayjs(entry.date).isBefore(now));

	if (pastEntries.length === 0) {
		// If no past entries, use the first (earliest) entry
		return vestingEntries[0]?.remaining || 0;
	}

	// Find the most recent past entry
	const nearestPastEntry = pastEntries.reduce((latest, current) =>
		dayjs(current.date).isAfter(dayjs(latest.date)) ? current : latest
	);

	return nearestPastEntry.remaining;
}

async function getTokenAddressesFromWalletLists(): Promise<
	{
		authority: PublicKey;
		tokenAccount: PublicKey;
	}[]
> {
	logger.info(`Fetching token accounts for locked DRIFT supply wallets`);

	const walletAddresses = Array.from(
		// Create a set to deduplicate
		new Set([
			// Drift Foundation addresses
			'9Wiiyvy8zzbZmJwxevi5CHZKs2VSZW7fvJJjrixviLA6',
			'HPjkU5hUR1diprB6Uihqxtr5hkRaJXFEetGjkVyEmoUR',
			'HiW2o8ESva3eyyA54a8AZbXbtVs6U4fvVbmFp3EQWoVT',
			// Champagne addresses
			'7LCwgH3TtA7v9jvPoU3zHhRUCgd2XNCdAwQSjBPDzFQ6',
			'DemTRm4sQbLxMywg9XST9TMYRmXfwNH6CCfiU4xb47kR',
			'Eqbh9PQyptxn4j3jx67vrMr43L4hxjm6gusNMMyypqum',
			'5hMjmxexWu954pX9gB9jkHxMqdjpxArQS2XdvkaevRax',
		])
	).map((address) => new PublicKey(address));

	logger.info(`Found ${walletAddresses.length} unique locked DRIFT supply addresses`);

	const tokenAccountAddresses = await Promise.all(
		walletAddresses.map((address) =>
			getAssociatedTokenAddress(DRIFT_TOKEN_MINT_PUBKEY, address, true)
		)
	);

	return tokenAccountAddresses.map((tokenAddress, index) => ({
		authority: walletAddresses[index],
		tokenAccount: tokenAddress,
	}));
}

/**
 * Bulk fetches the token balances of the locked supply wallets
 * @param connection
 * @returns
 */
async function getTokenBalances(connection: Connection) {
	const LOCKED_SUPPLY_TOKEN_ACCOUNTS = await getTokenAddressesFromWalletLists();
	const chunkedWallets = batchArray(LOCKED_SUPPLY_TOKEN_ACCOUNTS, 100); // Can fetch max 100 accounts at a time

	const accountsAndWallets: {
		account: AccountInfo<Buffer> | null;
		wallet: {
			tokenAccount: PublicKey;
			authority: PublicKey;
		};
	}[] = [];

	for (const chunk of chunkedWallets) {
		const chunkTokenAccounts = await connection.getMultipleAccountsInfo(
			chunk.map((wallet) => wallet.tokenAccount)
		);

		const accountsWithWallet = chunkTokenAccounts.map((account, index) => {
			return {
				account,
				wallet: chunk[index],
			};
		});

		accountsAndWallets.push(...accountsWithWallet);

		await sleep(1000); // Sleep for 1 second to avoid rate limiting
	}

	const balances = accountsAndWallets.map((accountAndWallet) => {
		if (!accountAndWallet.account) {
			return {
				balance: BigInt(0),
				wallet: accountAndWallet.wallet,
			};
		}

		const accountInfo = AccountLayout.decode(accountAndWallet.account.data);

		return {
			balance: accountInfo.amount,
			wallet: accountAndWallet.wallet,
		};
	});

	return balances;
}

/**
 * Returns the circulating supply of DRIFT tokens. Calculated by deducting the total locked supply from the total supply of 1B.
 * For multicoin wallets, uses the CSV vesting schedule instead of querying blockchain balances.
 * @param connection
 * @returns
 */
const getDriftCirculatingSupply = async (connection: Connection) => {
	// Get wallet balances for magna wallets and multi-sigs
	const accountAndBalances = await getTokenBalances(connection);

	const parsedBalances = accountAndBalances.map((accountAndBalance) =>
		BigNum.from(accountAndBalance.balance.toString(), DRIFT_TOKEN_PRECISION).toNum()
	);

	const totalWalletBalances = parsedBalances.reduce((acc, balance) => acc + balance, 0);

	// Add multicoin locked amount from CSV
	const multicoinLockedAmount = getMulticoinLockedAmount();

	// Add magna locked amount from API
	const magnaLockedAmount = await getMagnaLockedSupply();

	const totalLockedBalances =
		totalWalletBalances +
		multicoinLockedAmount +
		magnaLockedAmount.lockedSupply +
		TREASURY_BUYBACK_AMOUNT;

	const circulatingSupply = parseFloat(
		(DRIFT_TOKEN_TOTAL_SUPPLY - totalLockedBalances).toFixed(DRIFT_TOKEN_PRECISION)
	);

	console.table({
		totalWalletBalances,
		multicoinLockedAmount,
		magnaLockedAmount: magnaLockedAmount.lockedSupply,
		magnaAllocatedAmount: magnaLockedAmount.totalAllocationAmount,
		magnaUnlockedAmount: magnaLockedAmount.unlockedSupply,
		treasuryBuybackAmount: TREASURY_BUYBACK_AMOUNT,
		totalLockedBalances,
		circulatingSupply,
	});

	return circulatingSupply;
};

export const setupTokenTasks = ({
	connection,
	scheduler,
}: {
	connection: Connection;
	scheduler: ReturnType<typeof Scheduler>;
}) => {
	if (process.env.APP_STAGE === 'devnet') return;
	scheduler.scheduleTask(
		'token-stats',
		'0 11 * * *',
		async () => {
			logger.info('Fetching token stats');

			const circulatingSupply = await getDriftCirculatingSupply(connection);
			logger.info(`Circulating supply: ${circulatingSupply}`);

			setTokenStats(circulatingSupply);
			logger.info('Stored token stats');
		},
		{
			runImmediately: true,
		}
	);
};

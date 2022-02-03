import { AccountInfo, AccountLayout, u64 } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

export function parseTokenAccount(data: Buffer): AccountInfo {
	const accountInfo = AccountLayout.decode(data);
	accountInfo.mint = new PublicKey(accountInfo.mint);
	accountInfo.owner = new PublicKey(accountInfo.owner);
	accountInfo.amount = u64.fromBuffer(accountInfo.amount);

	if (accountInfo.delegateOption === 0) {
		accountInfo.delegate = null;
		// eslint-disable-next-line new-cap
		accountInfo.delegatedAmount = new u64(0);
	} else {
		accountInfo.delegate = new PublicKey(accountInfo.delegate);
		accountInfo.delegatedAmount = u64.fromBuffer(accountInfo.delegatedAmount);
	}

	accountInfo.isInitialized = accountInfo.state !== 0;
	accountInfo.isFrozen = accountInfo.state === 2;

	if (accountInfo.isNativeOption === 1) {
		accountInfo.rentExemptReserve = u64.fromBuffer(accountInfo.isNative);
		accountInfo.isNative = true;
	} else {
		accountInfo.rentExemptReserve = null;
		accountInfo.isNative = false;
	}

	if (accountInfo.closeAuthorityOption === 0) {
		accountInfo.closeAuthority = null;
	} else {
		accountInfo.closeAuthority = new PublicKey(accountInfo.closeAuthority);
	}

	return accountInfo;
}

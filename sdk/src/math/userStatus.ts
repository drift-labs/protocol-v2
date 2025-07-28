import { UserAccount, UserStatus } from '../types';

export function isUserProtectedMaker(userAccount: UserAccount): boolean {
	return (userAccount.status & UserStatus.PROTECTED_MAKER) > 0;
}

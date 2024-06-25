import { decodeUser } from '../decode/user';
import { PollingUserAccountSubscriber } from './pollingUserAccountSubscriber';

export class TestPollingUserAccountSubscriber extends PollingUserAccountSubscriber {
	async fetch(): Promise<void> {
		try {
			const dataAndContext =
				await this.connection.getAccountInfoAndContext(
					this.userAccountPublicKey,
					this.accountLoader.commitment
				);
			if (dataAndContext.context.slot > (this.user?.slot ?? 0)) {
				this.user = {
					data: decodeUser(dataAndContext.value.data),
					slot: dataAndContext.context.slot,
				};
			}
		} catch (e) {
			console.log(
				`PollingUserAccountSubscriber.fetch() UserAccount does not exist: ${e.message}-${e.stack}`
			);
		}
	}
}

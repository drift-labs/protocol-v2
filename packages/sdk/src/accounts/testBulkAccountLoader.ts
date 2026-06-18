import { AccountToLoad, BulkAccountLoader } from './bulkAccountLoader';

export class TestBulkAccountLoader extends BulkAccountLoader {
	async loadChunk(accountsToLoadChunks: AccountToLoad[][]): Promise<void> {
		if (accountsToLoadChunks.length === 0) {
			return;
		}

		for (const accountsToLoadChunk of accountsToLoadChunks) {
			for (const accountToLoad of accountsToLoadChunk) {
				const account = await this.connection.getAccountInfoAndContext(
					accountToLoad.publicKey,
					this.commitment
				);
				const newSlot = account.context.slot;
				if (newSlot > this.mostRecentSlot) {
					this.mostRecentSlot = newSlot;
				}

				if (accountToLoad.callbacks.size === 0) {
					continue;
				}

				const key = accountToLoad.publicKey.toBase58();
				const prev = this.bufferAndSlotMap.get(key);

				if (prev && newSlot < prev.slot) {
					continue;
				}

				let newBuffer: Buffer | undefined = undefined;

				if (account.value) {
					newBuffer = account.value.data;
				}

				if (!prev) {
					this.bufferAndSlotMap.set(key, { slot: newSlot, buffer: newBuffer });
					this.handleAccountCallbacks(accountToLoad, newBuffer, newSlot);
					continue;
				}

				const oldBuffer = prev.buffer;
				if (newBuffer && (!oldBuffer || !newBuffer.equals(oldBuffer))) {
					this.bufferAndSlotMap.set(key, { slot: newSlot, buffer: newBuffer });
					this.handleAccountCallbacks(accountToLoad, newBuffer, newSlot);
				}
			}
		}
	}
}

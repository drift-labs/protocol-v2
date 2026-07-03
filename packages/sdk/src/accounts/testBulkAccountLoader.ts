import { AccountToLoad, BulkAccountLoader } from './bulkAccountLoader';

/**
 * Test-only `BulkAccountLoader` that overrides `loadChunk` to fetch each account individually via
 * `connection.getAccountInfoAndContext` instead of batching through `getMultipleAccounts`. Used
 * against test validators/bankrun connections that don't implement the `_rpcBatchRequest` path
 * the base class relies on. Preserves the same per-account slot/buffer dedup semantics as the
 * base class (an update is only dispatched if the new slot is not older and the buffer changed).
 */
export class TestBulkAccountLoader extends BulkAccountLoader {
	/** Sequentially fetches every account in every chunk via individual RPC calls, dispatching callbacks for any that changed at a non-decreasing slot. Slower than the base class's batched `getMultipleAccounts` approach by design — intended for test environments only. */
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

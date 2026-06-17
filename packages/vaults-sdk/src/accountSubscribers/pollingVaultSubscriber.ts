import {
	Vault,
	VaultAccountEvents,
	VaultAccountSubscriber,
} from '../types/types';
import { PollingVaultsProgramAccountSubscriber } from './pollingVaultsProgramAccountSubscriber';

export class PollingVaultSubscriber
	extends PollingVaultsProgramAccountSubscriber<Vault, VaultAccountEvents>
	implements VaultAccountSubscriber
{
	async addToAccountLoader(): Promise<void> {
		if (this.callbackId) {
			console.log('Account for vault already added to account loader');
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.pubkey,
			(buffer, slot) => {
				if (!buffer) return;

				if (this.account && this.account.slot > slot) {
					return;
				}

				const account = this.program.account.vault.coder.accounts.decode(
					'vault',
					buffer
				);
				this.account = { data: account, slot };
				this._eventEmitter.emit('vaultUpdate', account);
				this._eventEmitter.emit('update');
			}
		);

		this.errorCallbackId = this.accountLoader.addErrorCallbacks((error) => {
			this._eventEmitter.emit('error', error);
		});
	}

	async fetch(): Promise<void> {
		await this.accountLoader.load();
		const bufferAndSlot = this.accountLoader.getBufferAndSlot(this.pubkey);
		if (!bufferAndSlot) return;
		const currentSlot = this.account?.slot ?? 0;
		if (bufferAndSlot.buffer && bufferAndSlot.slot > currentSlot) {
			const account = this.program.account.vault.coder.accounts.decode(
				'vault',
				bufferAndSlot.buffer
			);
			this.account = { data: account, slot: bufferAndSlot.slot };
		}
	}

	updateData(vaultAcc: Vault, slot: number): void {
		if (!this.account || this.account.slot < slot) {
			this.account = { data: vaultAcc, slot };
			this._eventEmitter.emit('vaultUpdate', vaultAcc);
			this._eventEmitter.emit('update');
		}
	}
}

import {
	VaultDepositor,
	VaultDepositorAccountEvents,
	VaultDepositorAccountSubscriber,
} from '../types/types';
import { PollingVaultsProgramAccountSubscriber } from './pollingVaultsProgramAccountSubscriber';

export class PollingVaultDepositorSubscriber
	extends PollingVaultsProgramAccountSubscriber<
		VaultDepositor,
		VaultDepositorAccountEvents
	>
	implements VaultDepositorAccountSubscriber
{
	async addToAccountLoader(): Promise<void> {
		if (this.callbackId) {
			console.log(
				'Account for vault depositor already added to account loader'
			);
			return;
		}

		this.callbackId = await this.accountLoader.addAccount(
			this.pubkey,
			(buffer, slot) => {
				if (!buffer) return;

				if (this.account && this.account.slot > slot) {
					return;
				}

				const account =
					this.program.account.vaultDepositor.coder.accounts.decode(
						'vaultDepositor',
						buffer
					);
				this.account = { data: account, slot };
				this._eventEmitter.emit('vaultDepositorUpdate', account);
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
			const account = this.program.account.vaultDepositor.coder.accounts.decode(
				'vaultDepositor',
				bufferAndSlot.buffer
			);
			this.account = { data: account, slot: bufferAndSlot.slot };
		}
	}

	updateData(vaultDepositorAcc: VaultDepositor, slot: number): void {
		if (!this.account || this.account.slot < slot) {
			this.account = { data: vaultDepositorAcc, slot };
			this._eventEmitter.emit('vaultDepositorUpdate', vaultDepositorAcc);
			this._eventEmitter.emit('update');
		}
	}
}

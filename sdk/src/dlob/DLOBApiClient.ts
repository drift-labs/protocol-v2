import fetch from 'node-fetch';
import { DLOBOrdersCoder } from './DLOBOrders';
import { DLOB } from './DLOB';

type DLOBApiClientConfig = {
	url: string;
};

export class DLOBApiClient {
	url: string;
	dlobCoder = DLOBOrdersCoder.create();
	lastSeenDLOB: DLOB;
	lastSeenSlot = 0;

	constructor(config: DLOBApiClientConfig) {
		this.url = config.url;
	}

	public async getDLOB(slot: number): Promise<DLOB> {
		const r = await fetch(this.url);
		if (!r.ok) {
			throw new Error(
				`Failed to fetch DLOB from ${this.url}. Status: ${r.status}, ${r.statusText}`
			);
		}

		const resp = await r.json();
		const responseSlot = resp['slot'];
		if (responseSlot > this.lastSeenSlot) {
			const dlobOrdersBuffer = Buffer.from(resp['data'], 'base64');
			const dlobOrders = this.dlobCoder.decode(Buffer.from(dlobOrdersBuffer));
			const dlob = new DLOB();
			dlob.initFromOrders(dlobOrders, slot);
			this.lastSeenDLOB = dlob;
			this.lastSeenSlot = responseSlot;
		}
		return this.lastSeenDLOB;
	}
}

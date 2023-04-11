import { PublicKey } from '@solana/web3.js';
import { Idl } from '@coral-xyz/anchor';
import { IdlCoder } from '@coral-xyz/anchor/dist/cjs/coder/borsh/idl';
import dlobIDL from './dlobIdl.json';
import { Order } from '../types';

export type DLOBOrder = { user: PublicKey; order: Order };

export type DLOBOrders = DLOBOrder[];

export class DLOBOrdersCoder {
	public constructor(private idl: Idl) {}

	static create(): DLOBOrdersCoder {
		return new DLOBOrdersCoder(dlobIDL as Idl);
	}

	public encode(dlobOrders: DLOBOrders): Buffer {
		const layout = IdlCoder.fieldLayout(
			{
				type: {
					vec: {
						defined: 'DLOBOrder',
					},
				},
			},
			this.idl.types
		);

		const size = 150 * dlobOrders.length;
		const buffer = Buffer.alloc(size);
		const len = layout.encode(dlobOrders, buffer);
		return buffer.slice(0, len);
	}

	public decode(buffer: Buffer): DLOBOrders {
		const layout = IdlCoder.fieldLayout(
			{
				type: {
					vec: {
						defined: 'DLOBOrder',
					},
				},
			},
			this.idl.types
		);
		return layout.decode(buffer) as DLOBOrders;
	}
}

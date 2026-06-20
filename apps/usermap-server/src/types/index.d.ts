import { Express } from 'express';
import { Connection } from '@solana/web3.js';
import { VelocityClient, Wallet } from '@velocity-exchange/sdk';
import { RedisClient } from '@velocity-exchange/common/clients';
import { WebsocketCacheProgramAccountSubscriber } from '../publisher';

export declare global {
	type Core = {
		app: Express;
		connection: Connection;
		wallet: Wallet;
		velocityClient: VelocityClient;
		redisClient: RedisClient;
		publisher: WebsocketCacheProgramAccountSubscriber;
	};
}

// to make the file a module and avoid the TypeScript error
export {};

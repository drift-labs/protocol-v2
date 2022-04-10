import { PublicKey } from '@solana/web3.js';

export const CLEARING_HOUSE_STATE_ACCOUNTS = {
	dammHkt7jmytvbS3nHTxQNEcP59aE57nxwV21YdqEDN: {
		state: new PublicKey('FExhvPycCCwYnZGeDsVtLhpEQ3yEkVY2k1HuPyfLj91L'),
		markets: new PublicKey('773hq3SbGPKVj93TXi5qV5CREuhxobywfALjS3XVHhLH'),
		orderState: new PublicKey('4cC34bWwTPGncBaX2S6v5mH3Lj4Nb3byPMrxQSDcY985'),
		tradeHistory: new PublicKey('FCuCXEoQppoaCYdttA7rK3HNQfYkTNEGpwuBESzYcENp'),
		depositHistory: new PublicKey(
			'C7rF2Qy2rnDGQLRijBRRArJyaeuQcFi81BXDrUCQ45ya'
		),
		fundingPaymentHistory: new PublicKey(
			'895iPhzwT2tBufLnRpYtBG3gif1HDDUfpH2AqbS5joo4'
		),
		fundingRateHistory: new PublicKey(
			'BWiJLMbmrwfqHVpcPJa8715XamNyNYamDDKQVQMnduEC'
		),
		extendedCurveHistory: new PublicKey(
			'7vBbqvMdtZLQdTVdzt5y63pZdAFE5W42kP3avngSJKCk'
		),
		liquidationHistory: new PublicKey(
			'CSFaaf8yVoTx6NcXUKtNPYAewv76CH2jATqSVRBvUWKM'
		),
		orderHistory: new PublicKey('DZ7XfUqyHoRKnJLRApxmJ943xHJ7NDBUTqpbooviEtbU'),
	},
};

/**
 * @module @velocity-exchange/sdk
 * Main package barrel — re-exports all public SDK types, classes, and utilities.
 *
 * Primary entry points:
 *   {@link VelocityClient}  — trading and keeper instruction builders (velocityClient.ts)
 *   {@link AdminClient}  — governance/admin instruction builders (adminClient.ts)
 *   {@link User}         — user account abstraction: margin queries, position accessors (user.ts)
 *   {@link DLOB}         — decentralized limit order book (dlob/DLOB.ts)
 *
 * Key re-exported namespaces: types, addresses/pda, accounts (subscribers), math, events, oracles, constants.
 */
import { BN } from './isomorphic/anchor';
import { PublicKey } from '@solana/web3.js';
import pyth from '@pythnetwork/client';

export * from './tokenFaucet';
export * from './oracles/types';
export * from './oracles/pythClient';
export * from './oracles/strictOraclePrice';
export * from './types';
export * from './accounts/fetch';
export * from './accounts/webSocketVelocityClientAccountSubscriber';
export * from './accounts/webSocketInsuranceFundStakeAccountSubscriber';
export { WebSocketAccountSubscriberV2 } from './accounts/webSocketAccountSubscriberV2';
export { WebSocketProgramAccountSubscriber } from './accounts/webSocketProgramAccountSubscriber';
export { WebSocketProgramUserAccountSubscriber } from './accounts/websocketProgramUserAccountSubscriber';
export { WebSocketProgramAccountsSubscriberV2 } from './accounts/webSocketProgramAccountsSubscriberV2';
export { WebSocketVelocityClientAccountSubscriberV2 } from './accounts/webSocketVelocityClientAccountSubscriberV2';
export * from './accounts/bulkAccountLoader';
export * from './accounts/bulkUserSubscription';
export * from './accounts/bulkUserStatsSubscription';
export { CustomizedCadenceBulkAccountLoader } from './accounts/customizedCadenceBulkAccountLoader';
export * from './accounts/pollingVelocityClientAccountSubscriber';
export * from './accounts/pollingOracleAccountSubscriber';
export * from './accounts/pollingTokenAccountSubscriber';
export * from './accounts/pollingUserAccountSubscriber';
export * from './accounts/pollingUserStatsAccountSubscriber';
export * from './accounts/pollingInsuranceFundStakeAccountSubscriber';
export * from './accounts/basicUserAccountSubscriber';
export * from './accounts/oneShotUserAccountSubscriber';
export * from './accounts/oneShotUserStatsAccountSubscriber';
export * from './accounts/types';
export * from './addresses/pda';
export * from './adminClient';
export * from './assert/assert';
export { PythLazerSubscriber, type PythLazerPriceFeedArray } from './pyth';
export * from './testClient';
export * from './user';
export * from './userConfig';
export * from './userStats';
export * from './userName';
export * from './userStatsConfig';
export * from './decode/user';
export * from './decode/customCoder';
export * from './velocityClient';
export * from './factory/oracleClient';
export * from './factory/bigNum';
export * from './events/types';
export * from './events/eventSubscriber';
export * from './events/fetchLogs';
export * from './events/txEventCache';
export * from './events/webSocketLogProvider';
export * from './events/parse';
export * from './events/pollingLogProvider';
export * from './jupiter/jupiterClient';
// Primary swap client interface - use this for all swap operations
export * from './swap/UnifiedSwapClient';
export * from './math/auction';
export * from './math/builder';
export * from './math/spotMarket';
export * from './math/conversion';
export * from './math/exchangeStatus';
export * from './math/funding';
export * from './math/market';
export * from './math/position';
export * from './math/oracles';
export * from './math/amm';
export * from './math/trade';
export * from './math/orders';
export * from './math/repeg';
export * from './math/liquidation';
export * from './math/margin';
export * from './math/insurance';
export * from './math/superStake';
export * from './math/spotPosition';
export * from './math/state';
export * from './math/tiers';
export * from './marinade';
export * from './orderParams';
export * from './slot/SlotSubscriber';
export * from './slot/SlothashSubscriber';
export * from './wallet';
export * from './keypair';
export * from './types';
export * from './math/utils';
export * from './config';
export * from './priorityFee';
export * from './oracles/pythClient';
export * from './oracles/pythLazerClient';
export * from './oracles/oracleId';
export * from './oracles/utils';
export * from './swift/swiftOrderSubscriber';
export * from './swift/signedMsgUserAccountSubscriber';
export * from './swift/grpcSignedMsgUserAccountSubscriber';
export * from './tx/fastSingleTxSender';
export * from './tx/retryTxSender';
export * from './tx/whileValidTxSender';
export * from './tx/priorityFeeCalculator';
export * from './tx/forwardOnlyTxSender';
export * from './tx/types';
export * from './tx/txHandler';
export * from './tx/txParamProcessor';
export * from './util/computeUnits';
export * from './util/digest';
export * from './util/tps';
export * from './util/promiseTimeout';
export * from './math/spotBalance';
export * from './velocityClientConfig';
export * from './dlob/DLOB';
export * from './dlob/DLOBNode';
export * from './dlob/NodeList';
export * from './dlob/DLOBSubscriber';
export * from './dlob/types';
export * from './dlob/orderBookLevels';
export * from './userMap/userMap';
export * from './userMap/referrerMap';
export * from './userMap/userStatsMap';
export * from './userMap/revenueShareEscrowMap';
export * from './userMap/userMapConfig';
export * from './math/bankruptcy';
export * from './orderSubscriber';
export * from './orderSubscriber/types';
export * from './auctionSubscriber';
export * from './auctionSubscriber/types';
export * from './memcmp';
export * from './decode/user';
export * from './blockhashSubscriber';
export * from './util/chainClock';
export * from './util/TransactionConfirmationManager';
export * from './clock/clockSubscriber';
export * from './indicative-quotes/indicativeQuotesSender';
export * from './constants';
export * from './constituentMap/constituentMap';
export * from './core';

export { BN, PublicKey, pyth };

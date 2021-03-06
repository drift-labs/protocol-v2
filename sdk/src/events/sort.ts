import {
	EventMap,
	EventSubscriptionOrderBy,
	EventSubscriptionOrderDirection,
	EventType,
	SortFn,
	Event,
} from './types';
import { OrderRecord } from '../types';
import { PublicKey, ZERO } from '../index';

function clientSortAscFn(): 'less than' {
	return 'less than';
}

function clientSortDescFn(): 'greater than' {
	return 'greater than';
}

function defaultBlockchainSortFn(
	currentEvent: EventMap[EventType],
	newEvent: EventMap[EventType]
): 'less than' | 'greater than' {
	return currentEvent.slot <= newEvent.slot ? 'less than' : 'greater than';
}

function orderRecordSortFn(
	currentEvent: Event<OrderRecord>,
	newEvent: Event<OrderRecord>
): 'less than' | 'greater than' {
	const currentEventMarketIndex = !currentEvent.maker.equals(PublicKey.default)
		? currentEvent.makerOrder.marketIndex
		: currentEvent.takerOrder.marketIndex;
	const newEventMarketIndex = !newEvent.maker.equals(PublicKey.default)
		? newEvent.makerOrder.marketIndex
		: newEvent.takerOrder.marketIndex;
	if (!currentEventMarketIndex.eq(newEventMarketIndex)) {
		return currentEvent.ts.lte(newEvent.ts) ? 'less than' : 'greater than';
	}

	if (currentEvent.fillRecordId.gt(ZERO) && newEvent.fillRecordId.gt(ZERO)) {
		return currentEvent.fillRecordId.lte(newEvent.fillRecordId)
			? 'less than'
			: 'greater than';
	} else {
		return currentEvent.ts.lte(newEvent.ts) ? 'less than' : 'greater than';
	}
}

export function getSortFn(
	orderBy: EventSubscriptionOrderBy,
	orderDir: EventSubscriptionOrderDirection,
	eventType: EventType
): SortFn {
	if (orderBy === 'client') {
		return orderDir === 'asc' ? clientSortAscFn : clientSortDescFn;
	}

	switch (eventType) {
		case 'OrderRecord':
			return orderRecordSortFn;
		default:
			return defaultBlockchainSortFn;
	}
}

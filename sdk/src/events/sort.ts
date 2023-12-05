import {
	EventMap,
	EventSubscriptionOrderBy,
	EventSubscriptionOrderDirection,
	EventType,
	SortFn,
} from './types';

function clientSortAscFn(): 'less than' {
	return 'less than';
}

function clientSortDescFn(): 'greater than' {
	return 'greater than';
}

function blockchainSortFn(
	currentEvent: EventMap[EventType],
	newEvent: EventMap[EventType]
): 'less than' | 'greater than' {
	if (currentEvent.slot == newEvent.slot) {
		return currentEvent.txSigIndex < newEvent.txSigIndex
			? 'less than'
			: 'greater than';
	}

	return currentEvent.slot < newEvent.slot ? 'less than' : 'greater than';
}

export function getSortFn(
	orderBy: EventSubscriptionOrderBy,
	orderDir: EventSubscriptionOrderDirection
): SortFn {
	if (orderBy === 'client') {
		return orderDir === 'asc' ? clientSortAscFn : clientSortDescFn;
	}

	return blockchainSortFn;
}

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

/** Orders events by `slot`, breaking ties by `txSigIndex` (position within the same transaction). Reproducible regardless of delivery order. */
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

/**
 * Selects the `SortFn` an `EventList` uses to place newly inserted events.
 * `orderBy: 'client'` always inserts at the position matching `orderDir`
 * (head for `'asc'`, tail for `'desc'`) regardless of the events' own
 * slot/index — i.e. pure arrival order. `orderBy: 'blockchain'` always uses
 * `blockchainSortFn` (slot, then `txSigIndex`); `orderDir` is ignored in that
 * case — blockchain order is always ascending by slot/`txSigIndex`.
 * @param orderBy Whether to sort by client arrival order or blockchain-produced order.
 * @param orderDir Sort direction; ignored when `orderBy` is `'blockchain'`.
 * @returns The `SortFn` to pass to `EventList`.
 */
export function getSortFn(
	orderBy: EventSubscriptionOrderBy,
	orderDir: EventSubscriptionOrderDirection
): SortFn {
	if (orderBy === 'client') {
		return orderDir === 'asc' ? clientSortAscFn : clientSortDescFn;
	}

	return blockchainSortFn;
}

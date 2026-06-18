import assert from 'assert';

import { parseKeypairUrl } from './ledgerWallet';

assert.deepStrictEqual(parseKeypairUrl(''), {
  walletId: undefined,
  account: undefined,
  change: undefined,
});

assert.deepStrictEqual(parseKeypairUrl('usb://ledger'), {
  walletId: undefined,
  account: undefined,
  change: undefined,
});

assert.deepStrictEqual(parseKeypairUrl('usb://ledger?key=1'), {
  walletId: undefined,
  account: 1,
  change: undefined,
});

assert.deepStrictEqual(parseKeypairUrl('usb://ledger?key=1/2'), {
  walletId: undefined,
  account: 1,
  change: 2,
});

assert.deepStrictEqual(
  parseKeypairUrl(
    'usb://ledger/BsNsvfXqQTtJnagwFWdBS7FBXgnsK8VZ5CmuznN85swK?key=0'
  ),
  {
    walletId: 'BsNsvfXqQTtJnagwFWdBS7FBXgnsK8VZ5CmuznN85swK',
    account: 0,
    change: undefined,
  }
);

assert.deepStrictEqual(
  parseKeypairUrl(
    'usb://ledger/BsNsvfXqQTtJnagwFWdBS7FBXgnsK8VZ5CmuznN85swK?key=0/0'
  ),
  {
    walletId: 'BsNsvfXqQTtJnagwFWdBS7FBXgnsK8VZ5CmuznN85swK',
    account: 0,
    change: 0,
  }
);

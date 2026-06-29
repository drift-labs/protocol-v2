// Shim over the velocity SDK's bankrun helpers. The vendored vaults suite was
// written against velocity-vaults' own copy of these helpers; the velocity SDK
// already ships an adapted BankrunContextWrapper that writes velocity's account
// layouts, so we re-export that instead of duplicating it here.
export {
	BankrunContextWrapper,
	BankrunConnection,
} from '../../../packages/sdk/src/bankrun/bankrunConnection';

// Fixed admin keypair the trusted-vault / fee-update suites fund and use as the
// protocol admin. Copied verbatim from velocity-vaults' tests/common so the derived
// admin pubkey matches what those tests expect.
export const TEST_ADMIN_KEYPAIR = [
	54, 38, 65, 230, 101, 94, 76, 41, 37, 158, 168, 53, 98, 164, 87, 79, 215, 170,
	58, 167, 3, 190, 216, 216, 145, 137, 204, 17, 67, 237, 24, 19, 45, 172, 46,
	221, 212, 152, 13, 196, 222, 175, 43, 21, 168, 63, 5, 227, 39, 148, 175, 49,
	153, 250, 52, 79, 21, 72, 72, 13, 155, 220, 155, 177,
];

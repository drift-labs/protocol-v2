export function getOrderSignature(
	orderId: number,
	userAccount: string
): string {
	return `${userAccount.toString()}-${orderId.toString()}`;
}

/** Error code attached to the `TxSendError` thrown when a transaction send times out without the SDK observing either a confirmation or a definite on-chain failure (see `BaseTxSender`/`TransactionConfirmationManager`). Not a Solana/program error code — it's SDK-internal, meaning "we don't know what happened." */
export const NOT_CONFIRMED_ERROR_CODE = -1001;

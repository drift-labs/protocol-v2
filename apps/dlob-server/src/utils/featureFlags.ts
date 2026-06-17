export const FEATURE_FLAGS = {
	// TODO : Remove this once we're confident that NEW_ORACLE_DATA_IN_L2 works .. delete corresponding code
	OLD_ORACLE_PRICE_IN_L2: true,
	NEW_ORACLE_DATA_IN_L2: true,

	// enables old orders endpoint, disabled by default since the response is too big now
	ENABLE_ORDERS_ENDPOINTS: process.env.ENABLE_ORDERS_ENDPOINTS
		? process.env.ENABLE_ORDERS_ENDPOINTS.toLowerCase() === 'true'
		: false,

	// disables periodically refreshing userAccounts via gPA
	DISABLE_GPA_REFRESH: process.env.DISABLE_GPA_REFRESH
		? process.env.DISABLE_GPA_REFRESH.toLowerCase() === 'true'
		: false,

	DISABLE_RATE_LIMIT: process.env.DISABLE_RATE_LIMIT
		? process.env.DISABLE_RATE_LIMIT.toLowerCase() === 'true'
		: false,
};

export default FEATURE_FLAGS;

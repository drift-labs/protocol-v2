// 🚨 :: These should all always be false in any committed code.
export const DEV_FLAGS = {
    TEST_COMPUTE_UNITS_OK_DURING_SIMULATION_BUT_FAIL_AT_RUNTIME: false, // Recreates the edge case where when sending a transaction the CU's are OK during simulation but fail at runtime.
};
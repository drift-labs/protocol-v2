// drift-vaults mocked oracles via its own pyth-layout writer; velocity's
// mockOracleNoProgram writes velocity's oracle layout (the program reads that),
// so we re-export the velocity helper instead.
export { mockOracleNoProgram } from '../../velocity/testHelpers';

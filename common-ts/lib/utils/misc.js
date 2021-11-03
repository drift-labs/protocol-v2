"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripBaseAssetPrecision = exports.stripMantissa = void 0;
const sdk_1 = require("@moet/sdk");
const stripMantissa = (bigNumber, precision = sdk_1.AMM_MANTISSA) => {
    if (!bigNumber)
        return 0;
    return (bigNumber.div(precision).toNumber() +
        bigNumber.mod(precision).toNumber() / precision.toNumber());
};
exports.stripMantissa = stripMantissa;
const stripBaseAssetPrecision = (baseAssetAmount) => {
    return (0, exports.stripMantissa)(baseAssetAmount, sdk_1.AMM_MANTISSA.mul(sdk_1.PEG_SCALAR));
};
exports.stripBaseAssetPrecision = stripBaseAssetPrecision;

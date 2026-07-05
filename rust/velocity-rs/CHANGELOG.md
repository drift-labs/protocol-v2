# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-07-05

### Fixed

- Corrected the `PYTH_LAZER_FEED_ID_TO_{PERP,SPOT}_MARKET_MAINNET` tables to Velocity's
  deployed market indices; they still carried the inherited Drift market numbering,
  causing keep-rs to subscribe to the wrong lazer feed for some markets (#203).

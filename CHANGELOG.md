# Changelog

This file records implementation, compatibility, and connection lifecycle changes. See [README.md](README.md) for installation and node usage.

## 1.0.34 - 2026-08-10

### Fixed

- Replaced the single timeout covering the complete Read/Write initialization sequence with an independent timeout for each major initialization stage.
- Initialization timeout messages now identify the exact active stage, including `comServer.init`, `createInstance`, `opcServer.init`, `addGroup`, `getItemManager`, `getSyncIO`, and `addItems`.
- Classified `0x800700A4` (`ERROR_MAX_THRDS_REACHED`) as a remote DCOM resource error alongside `0x1c00001b`. `0x80070024` (`ERROR_SHARING_BUFFER_EXCEEDED`) is also treated as resource exhaustion.
- Added readable error-code names to reconnect logs.
- Resource cooldown now requires consecutive resource errors; an unrelated transient failure resets the pre-cooldown resource streak.

## 1.0.33 - 2026-08-05

### Documentation

- Translated the public README and changelog to English.
- Kept the README focused on installation, configuration, node usage, status handling, and operator troubleshooting.

## 1.0.32 - 2026-08-04

### Documentation

- Reorganized the README around installation, Server configuration, Browse, Read, Write, node status, and common operator actions.
- Moved RPC/DCOM, resource cleanup, and reconnection implementation details to the changelog.

## 1.0.31 - 2026-08-04

### Changed

- Pinned `@tier0/node-dcom` to `1.2.20` and `@tier0/node-opc-da` to `1.0.15`.
- Bundled DCOM, OPC DA, and runtime dependencies in the final npm package for single-file offline installation.
- Added a configurable `Reconnect cooldown` to the Server node, defaulting to 5 minutes.
- Changed Browse to use POST and prefer credentials from the deployed configuration node.

### Fixed

- Fixed DCOM/RPC PDU parsing when TCP splits or coalesces packets.
- Fixed multi-fragment RPC response assembly and coalesced response boundaries.
- Added monotonically increasing RPC call IDs and response call-ID validation.
- Marked RPC framing errors, unexpected PDUs, call-ID mismatches, connection timeouts, and closed connections as transport-fatal.
- Transport-fatal failures now close the socket before local Session cleanup and do not send additional release RPCs over a poisoned stream.
- Completed OPC Group, SyncIO, ItemManager, COM object, and DCOM Session cleanup during normal shutdown, redeploy, and healthy-connection cleanup.
- Fixed shutdown during connection establishment so it no longer waits for the full outer timeout.
- Fixed OPC Group removal by server handle, duplicate disconnect forwarding, and incorrect result-length checks.
- Fixed OPC quality classification by applying the OPC Quality category mask.
- Added payload, type, AddItems result, and Write result validation to the Write node.
- Added timeout handling, per-server single-flight protection, and failure cleanup to Browse.
- Added readable descriptions for known Browse HRESULT values.

### Reconnection behavior

- Transient failures use an approximate `3s, 6s, 12s, 24s, 48s, 60s...` backoff, up to 10 consecutive attempts.
- Three consecutive `0x1c00001b` failures enter the configured resource cooldown.
- After cooldown, only one connection probe is made. Another failure enters cooldown again.
- Consecutive and resource failure counters reset only after a successful read or write.
- Access denied, invalid CLSID, class-not-registered, and invalid OPC server configuration errors stop automatic reconnection until the user corrects the configuration and deploys again.

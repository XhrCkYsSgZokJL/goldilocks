# Platform Build Constraints

**Category:** Platform · **Primary strategy:** MECHANICAL (re-apply settings) + the `ConvosCoreiOS` bridge pattern

## What

A set of build-level conventions Goldilocks depends on. None are "features," but a sync that ignores them produces confusing failures. Three matter most: **arm64-only libxmtp**, **ConvosCore must compile on macOS**, and the **`ConvosCoreiOS` bridge** for iOS-specific code.

## The constraints

### 1. libxmtp is arm64-only
`LibXMTPSwiftFFI.xcframework` has no x86_64 slice. Simulator builds must use `EXCLUDED_ARCHS=x86_64 ONLY_ACTIVE_ARCH=YES` on an Apple-Silicon host, or they fail at link with `undefined symbols ... XMTPiOS.*`. This is permanent. See the build command in the [Upstream Sync Playbook](../upstream-sync-playbook.md).

### 2. ConvosCore must compile on macOS
ConvosCore is tested on macOS (no simulator) for speed. Therefore:
- **Never `import UIKit`** in ConvosCore; use the cross-platform `ImageType` alias (`NSImage` on macOS, `UIImage` on iOS) in `ConvosCore/Sources/ConvosCore/Shared/ImageType.swift`.
- **Never `#if canImport(UIKit)`** — it breaks macOS compilation.
- iOS-only types (`UIImage`, `UIColor`, `UIApplication`) are forbidden in ConvosCore.

### 3. The `ConvosCoreiOS` bridge
When ConvosCore needs iOS behavior, **define a protocol in ConvosCore and inject an implementation from `ConvosCoreiOS`** — don't edit ConvosCore to use UIKit. Examples: `IdentityKeyWrapper` → `SecureEnclaveIdentityKeyWrapper` ([[identity-recovery-and-hardening]]); `PushNotificationRegistering`; image compression. **This is also the cheapest reconciliation pattern** — injected behavior lives in our additive files, so upstream edits to the core rarely touch it.

### 4. Synchronized file groups
`Convos`, `ConvosAppClip`, `NotificationService` are `PBXFileSystemSynchronizedRootGroup` — they compile whatever Swift files are on disk. So **adding/deleting a file needs no pbxproj edit**, and deleting a file from disk removes it from the build (how the [tab shell](app-shell-direct-root.md) was dropped). Only build phases and package refs still need pbxproj work.

### 5. The brand-config build phase
A "Copy Brand Config" build phase copies `shared/brand.json` into the bundle for `BrandConfig` ([[branding]]). After any pbxproj regeneration, **re-add this phase** to upstream's project rather than text-merging.

### 6. Strict type-check-time budget
The project enforces `-warn-long-function-bodies` / `-warn-long-expression-type-checking` as hard errors under strict CI. Don't raise the thresholds; fix the expression. See the playbook's _Lessons_ and `CLAUDE.md` → _Build Performance_.

## Files affected

- `Convos.xcodeproj/project.pbxproj` — the brand build phase + app-level package refs (the only hand-edited pbxproj parts).
- `ConvosCore/Sources/ConvosCore/Shared/ImageType.swift` (and other cross-platform aliases).
- `ConvosCore/Sources/ConvosCoreiOS/*` — the iOS implementations injected into ConvosCore.
- `ConvosCore/Package.swift` — dependency set (also where Sentry/Firebase are stripped — [[no-telemetry-no-egress]]).
- xcconfig files, entitlements.

## Markers

`EXCLUDED_ARCHS=x86_64`, `ImageType`, `ConvosCoreiOS`, `PBXFileSystemSynchronizedRootGroup`, "Copy Brand Config" build phase, `canImport(AppKit)`.

## Upstream-sync guidance

- **Re-apply build settings mechanically** — `EXCLUDED_ARCHS`, the brand build phase, entitlements. These are settings, not code; they don't "conflict" but they must be present.
- **Guard ConvosCore's macOS compilability** — if a sync introduces `UIKit` into ConvosCore, move it behind a protocol + `ConvosCoreiOS` impl, or use `ImageType`.
- **Prefer the bridge** — it's the lowest-reconciliation-cost way to add iOS behavior, because the impl is an additive (OWN) file.
- **Re-strip dependencies** in `Package.swift` each cycle (Sentry/Firebase — [[no-telemetry-no-egress]]).
- If type-check-time errors fire everywhere (even untouched files), suspect machine load / `lldb-rpc-server` leak, not the code (playbook → _Lessons_).

## Related

[[no-telemetry-no-egress]] (Package.swift strips) · [[identity-recovery-and-hardening]] (the bridge in action) · [[branding]] (brand build phase) · [[app-shell-direct-root]] (synchronized groups)

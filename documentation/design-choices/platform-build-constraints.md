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
When ConvosCore needs iOS behavior, **define a protocol in ConvosCore and inject an implementation from `ConvosCoreiOS`** — don't edit ConvosCore to use UIKit. Examples: `IdentityKeyWrapper` → `SecureEnclaveIdentityKeyWrapper` ([Identity recovery & hardening](identity-recovery-and-hardening.md)); `PushNotificationRegistering`; image compression. **This is also the cheapest reconciliation pattern** — injected behavior lives in our additive files, so upstream edits to the core rarely touch it.

### 4. Synchronized file groups
`Convos`, `ConvosAppClip`, `NotificationService` are `PBXFileSystemSynchronizedRootGroup` — they compile whatever Swift files are on disk. So **adding/deleting a file needs no pbxproj edit**, and deleting a file from disk removes it from the build (how the [tab shell](app-shell-direct-root.md) was dropped). Only build phases and package refs still need pbxproj work.

### 5. The brand-config build phase
A "Copy Brand Config" build phase copies `shared/brand.json` into the bundle for `BrandConfig` ([Branding](branding.md)). After any pbxproj regeneration, **re-add this phase** to upstream's project rather than text-merging.

### 6. Warnings posture + type-check budget (deliberate divergence)
**Goldilocks builds with `SWIFT_TREAT_WARNINGS_AS_ERRORS = NO` and 500ms type-check thresholds** (`-warn-long-function-bodies` / `-warn-long-expression-type-checking`), restored 2026-06 to match what main shipped. Upstream uses warnings-as-errors with 100/300 — under which first-touch module-deserialization (~350-800ms on a loaded machine, e.g. a bare `UITextField()`) fails builds on trivial code, including upstream's own unmodified files. Slow-type-check warnings are advisory: fix genuine solver blowups (per-expression timings reveal which is which — see the playbook), ignore measurement artifacts. **Each upstream sync must re-apply both settings** in `project.pbxproj` (three `OTHER_SWIFT_FLAGS` sites + every `SWIFT_TREAT_WARNINGS_AS_ERRORS`).

## Files affected

- `Convos.xcodeproj/project.pbxproj` — the brand build phase + app-level package refs (the only hand-edited pbxproj parts).
- `ConvosCore/Sources/ConvosCore/Shared/ImageType.swift` (and other cross-platform aliases).
- `ConvosCore/Sources/ConvosCoreiOS/*` — the iOS implementations injected into ConvosCore.
- `ConvosCore/Package.swift` — dependency set (also where Sentry/Firebase are stripped — [No telemetry / no-egress](no-telemetry-no-egress.md)).
- xcconfig files, entitlements.

## Markers

`EXCLUDED_ARCHS=x86_64`, `ImageType`, `ConvosCoreiOS`, `PBXFileSystemSynchronizedRootGroup`, "Copy Brand Config" build phase, `canImport(AppKit)`.

## Upstream-sync guidance

- **Re-apply build settings mechanically** — `EXCLUDED_ARCHS`, the brand build phase, entitlements. These are settings, not code; they don't "conflict" but they must be present.
- **Guard ConvosCore's macOS compilability** — if a sync introduces `UIKit` into ConvosCore, move it behind a protocol + `ConvosCoreiOS` impl, or use `ImageType`.
- **Prefer the bridge** — it's the lowest-reconciliation-cost way to add iOS behavior, because the impl is an additive (OWN) file.
- **Re-strip dependencies** in `Package.swift` each cycle (Sentry/Firebase — [No telemetry / no-egress](no-telemetry-no-egress.md)).
- If type-check-time errors fire everywhere (even untouched files), suspect machine load / `lldb-rpc-server` leak, not the code (playbook → _Lessons_).

## Related

[No telemetry / no-egress](no-telemetry-no-egress.md) (Package.swift strips) · [Identity recovery & hardening](identity-recovery-and-hardening.md) (the bridge in action) · [Branding](branding.md) (brand build phase) · [App shell: direct root](app-shell-direct-root.md) (synchronized groups)

# Signed Binary Distribution

This note captures the release path for making the Gemma Desktop macOS `.dmg` suitable for public distribution.

## Scope

This workstream is about the `gemma-desktop` app, not the full monorepo publishing story.

The goal is to produce a macOS installer that can be downloaded, opened, installed, and launched by normal users without Gatekeeper warnings or manual security overrides.

## Current State

Gemma Desktop already has a basic Electron packaging path:

- `gemma-desktop/electron-builder.yml` declares macOS `dmg` and `zip` targets.
- root `npm run dist` builds the SDK and then runs the desktop app distribution script.
- `gemma-desktop` runs `prepare-read-aloud-assets`, `electron-vite build`, `scripts/prepare-pack.js`, and then `electron-builder --mac`.
- `scripts/prepare-pack.js` stages a clean app bundle with runtime dependencies copied from the monorepo install.

This is enough to make a local DMG, but not enough to call the artifact publishable.

## Release Bar

A publishable Gemma Desktop `.dmg` should be:

- built from a reproducible app bundle
- signed with an Apple Developer ID Application certificate
- built with hardened runtime enabled
- signed with explicit Electron/macOS entitlements
- notarized by Apple
- stapled after notarization
- verified with Gatekeeper tooling
- tested from a clean install path, preferably `/Applications`
- published with checksums and release notes

## App Identity

The current app identity is:

```yaml
appId: com.gemmadesktop.app
productName: Gemma Desktop
```

Before public release, decide whether `com.gemmadesktop.app` is the durable bundle identifier.

Changing the bundle identifier later can affect:

- macOS permission prompts and grants
- userData location expectations
- auto-update identity
- signing and notarization history
- user support and diagnostics

## Signing

Public direct distribution outside the Mac App Store should use an Apple Developer Program account and a Developer ID Application certificate.

The release flow should not depend on ad hoc signing for public artifacts. Ad hoc or unsigned builds are acceptable only for local development and packaging smoke tests.

Expected CI or local release secrets include either App Store Connect API key credentials or Apple ID notarization credentials, plus the signing certificate material.

Typical environment variables:

```sh
CSC_LINK=...
CSC_KEY_PASSWORD=...
APPLE_TEAM_ID=...
APPLE_API_KEY=...
APPLE_API_KEY_ID=...
APPLE_API_ISSUER=...
```

If API key auth is not available, use Apple ID notarization credentials instead:

```sh
APPLE_ID=...
APPLE_APP_SPECIFIC_PASSWORD=...
APPLE_TEAM_ID=...
```

Do not commit certificates, passwords, API keys, or notarization credentials.

## Hardened Runtime And Entitlements

Gemma Desktop should enable hardened runtime in `electron-builder.yml`.

Start with explicit entitlement files under `gemma-desktop/resources/`, for example:

- `entitlements.mac.plist`
- `entitlements.mac.inherit.plist`

Likely Electron/native-module entitlements to evaluate:

```xml
<key>com.apple.security.cs.allow-jit</key>
<true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
<true/>
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
```

These should be treated as a starting hypothesis, not final policy. Validate them against real app behavior because Gemma Desktop uses Electron, native modules, node-pty, ONNX/runtime assets, speech/read-aloud assets, screenshot flows, microphone/camera permission flows, and local runtime integrations.

The entitlement set should be minimal but realistic. Avoid cargo-culting broader permissions than the app actually needs.

## Electron Builder Shape

The mac config should move toward an explicit signed release shape:

```yaml
mac:
  icon: resources/icon.icns
  category: public.app-category.developer-tools
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: resources/entitlements.mac.plist
  entitlementsInherit: resources/entitlements.mac.inherit.plist
  target:
    - dmg
    - zip
```

Keep both `dmg` and `zip` targets. The DMG is the user-facing installer; the zip may be useful for future macOS auto-update support.

## Verification

Add a release verification script that checks the generated app and DMG directly.

Useful commands:

```sh
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Gemma Desktop.app"
spctl --assess --type execute --verbose "dist/mac-arm64/Gemma Desktop.app"
spctl --assess --type open --context context:primary-signature --verbose "dist/Gemma Desktop-*.dmg"
xcrun stapler validate "dist/Gemma Desktop-*.dmg"
```

The script should also confirm expected packaged resources exist, including app output, runtime dependencies, icons, and read-aloud assets.

## Clean Machine Install Test

Before calling a DMG publishable, test the user path:

1. Download or copy the DMG to a clean macOS user profile or machine.
2. Mount the DMG.
3. Drag Gemma Desktop into `/Applications`.
4. Launch from Finder.
5. Confirm there is no Gatekeeper override flow.
6. Confirm app settings and userData paths are correct.
7. Confirm runtime discovery works for local providers.
8. Confirm node-pty/terminal-backed behavior works.
9. Confirm read-aloud assets load.
10. Confirm microphone, camera, screen capture, and notification prompts behave correctly.
11. Confirm no native module signature errors appear in logs.

## Release Artifacts

A release should publish:

- `Gemma Desktop-x.y.z-arm64.dmg`
- `Gemma Desktop-x.y.z-arm64.zip`
- optional x64 or universal artifacts, once architecture support is decided
- `SHA256SUMS.txt`
- release notes with user-visible changes and known risks
- notarization and verification evidence, either in CI logs or saved release notes

## Architecture Decision

Decide whether the first public macOS release is:

- Apple Silicon only
- Intel and Apple Silicon as separate builds
- universal

Apple Silicon only is the simplest path if the product is currently optimized for modern local model workflows. Separate architecture artifacts are more explicit. Universal builds are convenient for users but increase artifact size and native dependency risk.

## Suggested Scripts

Add focused scripts rather than overloading development packaging:

```json
{
  "dist:mac": "npm run prepare:read-aloud-assets && electron-vite build && node scripts/prepare-pack.js --increment-installer-version && electron-builder --projectDir .packaging/app --config electron-builder.yml --mac",
  "dist:mac:signed": "npm run dist:mac",
  "verify:mac-release": "node scripts/verify-mac-release.js"
}
```

The signed script can initially call the same builder command and rely on environment-driven signing. Once release needs become clearer, split local unsigned packaging from signed notarized release packaging.

## Recommended Milestones

1. Confirm final app id and macOS architecture strategy.
2. Add entitlements and hardened runtime config.
3. Add a local release verification script.
4. Produce one signed and notarized DMG locally.
5. Validate that DMG through the clean-machine install test.
6. Add GitHub release packaging only after the local release path is boring and repeatable.

## Known Risks

- Native modules may require entitlement adjustments after hardened runtime is enabled.
- Read-aloud, speech, screenshot, terminal, and local runtime workflows need manual verification from the installed app, not only build-time checks.
- Notarization can succeed while runtime behavior still fails due to missing resources or native module loading errors.
- Auto-update support should not be assumed just because a zip artifact exists.
- User-curated app data, especially memory and installed skills, must not be touched by packaging, release, reset, or install-test cleanup scripts.

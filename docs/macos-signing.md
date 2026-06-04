# macOS Signing And Notarization

Gemma Desktop release builds are signed with a Developer ID Application certificate and notarized with Apple's notary service on every push to `main`.

Local builds do not require Apple credentials. GitHub release builds do require the repository secrets below and will fail before publishing if any secret is missing.

## Required GitHub Secrets

Set these in GitHub under `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`.

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded `.p12` export of the Developer ID Application certificate, including its private key. |
| `CSC_KEY_PASSWORD` | Password used when exporting the `.p12`. |
| `APPLE_API_KEY_P8` | Full contents of the App Store Connect API key `.p8` file. |
| `APPLE_API_KEY_ID` | Key ID shown for that App Store Connect API key. |
| `APPLE_API_ISSUER` | Issuer ID shown on the App Store Connect API page. |

Do not commit the `.p12`, `.p8`, passwords, key IDs, or issuer ID to the repository.

## Create The Developer ID Certificate

Create the certificate signing request on your Mac first:

1. Open `Keychain Access`.
2. In the menu bar, choose `Keychain Access` -> `Certificate Assistant` -> `Request a Certificate From a Certificate Authority...`.
3. Use the Apple Developer account email for `User Email Address`.
4. Use your name or developer/team name for `Common Name`.
5. Leave `CA Email Address` empty.
6. Choose `Saved to disk`.
7. Save the `.certSigningRequest` file somewhere private.

Then create and install the certificate:

1. Open <https://developer.apple.com/account/resources/certificates/list>.
2. Click the add button.
3. Choose `Developer ID Application`.
4. Upload the `.certSigningRequest` file.
5. Download the generated `.cer`.
6. Double-click the `.cer` to install it into Keychain Access.

Then export the certificate for CI:

1. In Keychain Access, open `My Certificates`.
2. Find `Developer ID Application: ...`.
3. Expand it and confirm it has a private key underneath it.
4. Select the certificate and its private key, then export as a `.p12`.
5. Choose a strong temporary password for the `.p12`; this becomes `CSC_KEY_PASSWORD`.

Convert the `.p12` to a single-line base64 secret:

```sh
base64 -i DeveloperIDApplication.p12 | tr -d '\n' | pbcopy
```

Paste that clipboard value into the GitHub secret named `CSC_LINK`.

## Create The Notarization API Key

Use a Team API Key, not an Individual API Key.

1. Open <https://appstoreconnect.apple.com/access/integrations/api>.
2. If API access is not enabled yet, the Account Holder must request access.
3. Open `Team Keys`.
4. Click `Generate API Key`.
5. Use a name like `Gemma Desktop Notarization`.
6. Choose an access role that can use notarization. `App Manager` is the common Electron notarization recommendation.
7. Generate the key.
8. Copy the `Key ID`; this becomes `APPLE_API_KEY_ID`.
9. Copy the `Issuer ID`; this becomes `APPLE_API_ISSUER`.
10. Download the `.p8` file once and store it somewhere private.

Load the `.p8` file into the GitHub secret:

```sh
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
```

## Set The Secrets With GitHub CLI

After the `.p12` is exported and the `.p8` is downloaded:

```sh
base64 -i DeveloperIDApplication.p12 | tr -d '\n' | gh secret set CSC_LINK
gh secret set CSC_KEY_PASSWORD
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID
gh secret set APPLE_API_ISSUER
```

For the three prompt-based commands, paste the exact value when `gh` asks.

## Verify A Release Locally

After GitHub publishes a release DMG, download it and run:

```sh
mount_dir="$(mktemp -d)"
hdiutil attach Gemma.Desktop-*.dmg -nobrowse -readonly -mountpoint "${mount_dir}"
spctl --assess --type execute --verbose=4 "${mount_dir}/Gemma Desktop.app"
codesign --verify --deep --strict --verbose=2 "${mount_dir}/Gemma Desktop.app"
xcrun stapler validate "${mount_dir}/Gemma Desktop.app"
hdiutil detach "${mount_dir}"
rmdir "${mount_dir}"
```

If `spctl`, `codesign`, and `stapler` pass, the app should open without the unsigned-app Gatekeeper failure path.

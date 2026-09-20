# Hælan for Android

The companion app: it reads Health Connect on the phone and uploads what it finds to a
Hælan instance, with no Google Cloud project. Launcher label **Hælan**; `applicationId`
`com.haelan.android` (plus `.debug` on review builds, so both install side by side).

## Build

A fresh clone is enough: JDK 17 (the JBR inside Android Studio works), the Android SDK, and Node
with `pnpm` at the repository root for the token palette. Android Studio opens this directory as
a Gradle project, and nothing here needs the IDE.

```
pnpm install                                 # repository root, once per clone
pnpm --filter @haelan/tokens build:android   # the palette, into app/build/haelan-tokens
cd apps/android
./gradlew assembleDebug                      # gradlew.bat on Windows
```

The palette step is mandatory: the build fails with the command to run when the generated
resources are missing, because an Android build must not need a Node toolchain. With no
machine-local SDK path, point `JAVA_HOME` at the Studio JBR and `ANDROID_HOME` at the SDK, or
write `sdk.dir` into `local.properties`, which is git-ignored.

Two more targets, neither needing a device or an emulator:

```
./gradlew testDebugUnitTest   # the unit tests, on the JVM
./gradlew lintDebug           # NewApi and missing translations: a red build, not a warning
```

The APK lands at `app/build/outputs/apk/debug/haelan-android-debug.apk`. Copy it to the phone and
open it, or `adb install -r` it. A debug build is signed with the debug key, so it needs no
keystore and none of the release variables below. The phone needs Android 8.0 (API 26), and
Health Connect is part of the platform only from Android 14: below that the app says it is not
available rather than reading an empty history.

## Signing a release

The key never enters the repository. The build reads four values, environment first and a
local `.env` file second:

```
HAELAN_KEYSTORE_BASE64
HAELAN_KEYSTORE_PASSWORD
HAELAN_KEY_ALIAS
HAELAN_KEY_PASSWORD
```

Copy `.env.example` to `.env` and fill it in. That file is git-ignored and must stay that
way: it holds the key in plain text, for one machine only. CI passes the same four values
as environment variables instead. A release build with neither fails before packaging and
names what is missing; debug builds need none of this.

Minting the real key is the owner's job, once, before the first release: `.env.example`
names the four values, kept as repository secrets for CI and backed up with the key file in
two places. A lost key cannot be replaced, only abandoned: Android refuses an update signed
with a different key, and every installed copy would need a reinstall, losing what the app
keeps locally.

## Distribution

No Google Play listing. Each release tagged `android-v<version>` carries a signed APK, and
Obtainium is the update path: add this repository and new versions arrive on their own. The button
in the repository's own README carries the right settings, including the release filter, so nothing
has to be typed into a menu.

Two costs come with this path, stated rather than glossed:

- Installing the APK means installing from an unknown source, and Android asks for confirmation
  before it proceeds.
- Without Obtainium there are no automatic updates. A pull request build is not an update channel
  either: workflow artifacts expire after 90 days and exist for review, while the release
  attachment is the distribution.

No Play listing also means no health apps declaration and no review, which is part of what makes
this path attractive.

The tag is the authority. Retagging or deleting an `android-v` tag lets a lower version code ship
afterwards, and Android refuses that as a downgrade on every phone that already has the app. There
is no recovery but a higher version.

## Pairing a phone to a person

On the instance side, the setup wizard either closes without a Google client (Continue
without Google) or the person joins through an invite: either way the choice of path is
per person. On the phone side, install the APK, grant the Health Connect read permissions
it asks for, then type the instance address and sign in with username and password.

## Traffic

On a home network the traffic is cleartext HTTP by default, session cookie included, and
that is said here on purpose. It matches the project's non-goals: no Play review, no
accounts anywhere else, nothing to intercept past the LAN.

Encryption is not something the app adds; it follows the address that is typed. Put the
instance behind a TLS terminating proxy, or on Tailscale whose names carry a real
certificate, type an `https` address at login, and everything travels encrypted with
nothing to change in the app. The phone trusts the system anchors only, so a self-signed
certificate is refused rather than worked around.

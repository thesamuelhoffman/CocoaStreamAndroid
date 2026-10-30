# CocoaStream for Android

CocoaStream is an installable Android app. Android 7.0 (API 24) or newer is required. Its launcher icon and home-screen entry are included in the APK.

## Install from GitHub

1. Open this repository on GitHub and tap **Releases**.
2. Download **CocoaStream.apk** from the latest release.
3. Open the download, allow your browser to install apps if Android asks, then tap **Install**. CocoaStream appears in your app drawer and home-screen app list.

Publishing a GitHub release automatically builds the APK and attaches it to that release. A manual run from the **Actions** tab instead saves the APK as a downloadable workflow artifact. GitHub documents [releases as a way to distribute binary files](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).

To put this folder in a new public GitHub repository, create an empty repository on GitHub, then run these commands here (replace the remote with your repository address):

```bash
git init -b main
git add .
git commit -m "Initial CocoaStream Android app"
git remote add origin https://github.com/YOUR-NAME/YOUR-REPOSITORY.git
git push -u origin main
```

Then create and publish release tag `v1.2.3` in GitHub's **Releases** page. The workflow builds and attaches `CocoaStream.apk`.

### Keep app updates installable

Android only installs an update when it has the same signing key as the installed app. For stable GitHub releases, add these four repository Actions secrets before publishing the first release:

- `ANDROID_KEYSTORE_BASE64` — base64-encoded private release keystore
- `ANDROID_STORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Never add a keystore or passwords to the repository. Without those secrets, the workflow still builds an APK using its temporary GitHub runner key; that APK is suitable for a first install, but later workflow builds will need the previous app uninstalled before installing the new one.

## First launch

The first run opens **Create account**. Profiles are stored locally on that phone; they do not sync between devices. Existing guest watch history, ratings, and saved titles on an upgraded installation are copied into the first profile you create.

## Playback and add-ons

- Playback keeps a five-second back buffer and targets twenty seconds ahead. The window moves with the playhead; it starts filling only after you choose a source. Weak or slow sources can still rebuffer.
- Four custom Linux add-ons are included with the standard defaults: Star Wars Universe, Cartoon Network, Flix-Streams Free, and Asian-TV. Other configured add-ons used credential-bearing, account-specific, or private hosting URLs, so they are not copied into this public project. Flix-Streams Free was reporting unhealthy in the latest saved Linux status and may not respond.
- Casting supports discovered Chromecast, AirPlay, and DLNA receivers. It needs a compatible TV on the same local network; casting has not yet been tested against a physical receiver.

Roku, Samsung Tizen, and LG webOS do not install Android APKs; they need separate platform apps.

## Build and check

Install JDK 17 and Android SDK Platform 34, then run:

```bash
./gradlew assembleRelease
```

Run the source regression checks with:

```bash
npm install
bash scripts/test.sh
```

The generated APK is `app/build/outputs/apk/release/app-release.apk`. `build.sh` is a short alias for the Gradle Wrapper command.

## Compatibility notes

The APK bundles ARM64, ARMv7, and x86_64 native libraries. The UI and launcher work on Android 7 and newer, but this is not a measured 95% device-coverage claim. The bundled torrent library uses 4 KiB native alignment; 16 KiB-page device support needs an updated native library and device testing.

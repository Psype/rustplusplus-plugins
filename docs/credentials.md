# Credentials Documentation

> To be able to use an instance of the bot properly, you want to setup your Credentials. Adding these credentials makes it possible for you to pair with servers as well as connecting to them.

## Retrieving Credentials

The old rustplusplus credential application is no longer the canonical registration path. Use the current
[`rustplus.js` FCM registration flow](https://github.com/liamcottle/rustplus.js#using-the-command-line-tool) on a trusted
desktop with a compatible Chromium browser installed:

```powershell
npx.cmd --yes @liamcottle/rustplus.js@latest --config-file=rustplus.config.json fcm-register
```

On the current Windows development workstation, Google Chrome is unavailable and Brave must be used from:

```text
C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe
```

The installed local CLI currently has this path set as `chromePath` in
`node_modules/@liamcottle/rustplus.js/cli/index.js`. To use that exact local copy, run:

```powershell
node .\node_modules\@liamcottle\rustplus.js\cli\index.js --config-file=rustplus.config.json fcm-register
```

This `node_modules` edit is deliberately untracked and will be lost after reinstalling dependencies. Reapply the
Brave `chromePath` before rerunning the local command, or use the upstream `npx.cmd` command on a machine where its
browser launcher works.

This performs the complete required chain: Google GCM/Firebase registration, FCM token creation, Expo token exchange,
Steam login, and registration of that Expo token with the Facepunch Rust Companion service. Keep the resulting JSON
private; it contains long-lived push credentials.

Run it on a trusted desktop, not the headless dedicated server. The CLI starts a loopback callback on port `3000` and
launches a temporary Chromium profile with browser security disabled so it can emulate the Rust app's
`ReactNativeWebView.postMessage` login bridge. Close that temporary browser after completion. If port 3000 is already
occupied, stop the local process using it before retrying.

Opening `https://companion-rust.facepunch.com/login` or using a Chrome extension can yield a short-lived Rust+
`AuthToken`, but that token alone is insufficient: the bot listener needs the separately generated GCM `androidId`
and `securityToken`, and the corresponding FCM/Expo push token must be registered with Facepunch. Do not paste a token
captured for another bot into this project and never publish a registration URL containing `token=`. The upstream CLI
performs the complete device registration locally.

Copy only these values from the generated file into Discord `/credentials add`:

- `fcm_credentials.gcm.androidId` → `gcm_android_id`
- `fcm_credentials.gcm.securityToken` → `gcm_security_token`
- your SteamID64 → `steam_id`

`issued_date` and `expire_date` are optional legacy metadata. Reusing `/credentials add` for the same SteamID64 and
Discord user now renews the stored credentials atomically and restarts the corresponding listener; removing the old
entry first is unnecessary. Credential secrets are never written to bot logs.

`rustplus.config.json` is ignored by Git in this workspace. Keep it local and private; do not upload the whole file to
the Linux bot host. The bot needs the three values above through its credential command, not the registration file.

After renewal, pair the active server once from Rust while the bot is running. A healthy end-to-end path logs
`Facepunch push delivery verified` and `notification received: channel="pairing"`. `MCS login accepted` alone only
proves the Google transport credentials, not Facepunch delivery to that device.

![Credentials discord Image](images/bot_setup/credentials_discord.png)

* This process is the same for the owner of the bot as well as any teammate that wants to register credentials. Once a teammate has registered credentials, they can pair with the server in game.

![Teammates Paired with Server](images/bot_setup/teammates_paired.png)

## Why is Credentials necessary?

Credentials are necessary in order to get the following:

* Server Pairing Notifications
* Smart Devices Pairing Notifications
* Smart Alarm Notifications
* Player Offline Death Notifications
* Teammate Login Notifications
* Facepunch News

Without these, the bot would not operate properly.

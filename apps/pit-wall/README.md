# Pit Wall

The streamer's phone beside the keyboard. Viewers stay in Twitch. The app shows
real runner state over the local network, gives a local notification and haptic
when a bug arrives, and sends a round-bound veto or one enum hint back to the Mac.
No Twitch credentials, source code or Codex logs go to the phone.

Stephen verified the Android preview native build at `eeae759` on 2026-10-31
(EAS build `380e3f3e`). iOS native compilation and physical-device behaviour
remain unverified. Both JavaScript bundles are checked in CI.

## Build and install

Use Node 22 and pnpm from the repository root:

```sh
CI=true pnpm ci:local
cd apps/pit-wall
pnpm dlx eas-cli@latest login
pnpm dlx eas-cli@latest build:configure
pnpm dlx eas-cli@latest device:create
pnpm dlx eas-cli@latest build --profile development --platform ios
pnpm dlx eas-cli@latest build --profile development --platform android
```

Both iOS profiles use local signing credentials for the app and widget targets.
Keep signing credentials untracked and available locally before an EAS build.

EAS login, Apple signing and device registration belong to the streamer. EAS is
not run by the sandbox. Install the resulting internal iOS build or Android APK
on the phone. Start Metro from this directory with `pnpm exec expo start --dev-client`.
The native module and widget extension require a custom development or preview
build; Expo Go does not contain them. A physical iPhone with iOS 16.4 or newer is
needed for Live Activities; Dynamic Island additionally needs supported hardware.

For installable preview builds that do not need Metro:

```sh
cd apps/pit-wall
pnpm dlx eas-cli@latest build --profile preview --platform ios
pnpm dlx eas-cli@latest build --profile preview --platform android
```

Run commands from the repository root or enter `apps/pit-wall` once; do not enter
the same directory again after completing the first block. The local config
plugin creates the Swift ActivityKit extension during prebuild. The app config
records the existing EAS project and widget target; signing stays outside the
sandbox. Preserve the configured app and extension
bundle IDs. Internal iOS distribution is ad hoc, so register the presenting phone
before building.

## Pair a real runner

1. Connect the phone and Mac to a trusted private Wi-Fi network. Disable guest
   isolation and allow incoming TCP port 4318 in the Mac firewall for this session.
2. On the Mac, start the usual live runner with the optional gateway enabled:
   `PIT_WALL=1 pnpm round:live`. Port 4317 remains the overlay's port.
3. Enter the Mac's private IPv4 address and the six-digit code printed in the
   terminal. Tap **Pair phone**. Allow local network and notification permissions.
4. Wait for **LIVE** and start a real round using the existing Twitch workflow.
   The phone should show the changing score, head start, bug and actual Codex step.
5. During the head start, **Veto round** cancels before Codex starts. A hint button
   sends exactly its named family before Codex starts. **Sending...** waits for the runner's receipt;
   **Accepted** confirms the action, while a rejection gives the runner's reason.
6. **Forget pairing** removes the stored phone token. Restarting the gateway
   invalidates its tokens; pair with the new terminal code after a runner restart.

The gateway uses plaintext `ws://<private-ip>:4318`, restricted in the app to
private IPv4 addresses. A pairing token grants streamer actions for that runner.
Anyone observing the LAN can intercept it. Use a trusted network, never expose
the port to the internet, and stop the runner when finished. The token is held
in Expo SecureStore and bound to the saved Mac address. The code is not saved.

## Device checks still required

Unit tests cover the protocol, state ordering, reconnect deduplication, clock
translation and round-bound action receipts. They do not prove physical-device
delivery or native compilation. Before filming, verify on the actual build:

- Pair, turn Wi-Fi off and back on, and confirm reconnect uses the saved token.
  A disconnected screen is labelled **Last received** and its actions are disabled.
- Land a real bug and observe a local notification and haptic once. Permission
  denial must show the on-screen warning. Focus/Do Not Disturb and phone settings
  can suppress sound and haptics.
- Veto before Codex starts, then verify the runner cancels and logs the action.
  Start another round, send one hint and verify the real Codex input and receipt.
- Confirm the iOS Live Activity and Dynamic Island display the round; on Android
  check the ongoing notification. A foreground disconnect ends native status.
  Lock the phone: its last Activity should remain, show stale after 60 seconds on
  iOS, and expire after 60 seconds on Android. Foregrounding reconnects to fresh state.
- Resolve a real round and read the autopsy headline. Confirm the phone has no
  Twitch token and that port 4318 is closed when `PIT_WALL` is unset.

Keep Pit Wall open beside the keyboard. It prevents screen sleep. Local
notifications are scheduled immediately when the running app receives a bug
event. There is no APNs/FCM registration, remote push server or background fetch.
The app closes the gateway socket when backgrounded and reconnects on foreground;
it cannot promise fresh phone or lock-screen updates while suspended. Live
Activity state and Android ongoing state are updated locally from received
gateway events. Last received native state remains on background: iOS marks it
stale after 60 seconds and Android removes its notification after 60 seconds. No stream
latency delay is applied to this streamer tool.

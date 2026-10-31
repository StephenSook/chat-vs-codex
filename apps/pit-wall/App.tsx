import type { Action, BugFamily } from "@chat-vs-codex/pit-wall/protocol";
import {
  BUG_FAMILIES,
  parseServerFrame,
} from "@chat-vs-codex/pit-wall/protocol";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { requireNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useEffect, useReducer, useRef, useState } from "react";
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  canHint,
  canVeto,
  countdownSeconds,
  gatewayUrl,
  initialPhoneState,
  nativePayload,
  phoneReducer,
} from "./src/state";

const KEY = "pit-wall-pairing";
const clay = {
  paper: "#F5EADC",
  ink: "#322C28",
  orange: "#C34C24",
  blue: "#2859B7",
  card: "#FFF8EF",
};
const labels: Record<BugFamily, string> = {
  "gravity-sign": "Gravity",
  "collision-off-by-one": "Collision",
  "swapped-controls": "Controls",
  "coyote-never-expires": "Coyote time",
  "jump-buffer": "Jump buffer",
  "enemy-ledge-turn": "Enemy ledge",
};
const phaseLabels = {
  idle: "Ready for chat",
  preparing: "Preparing",
  "head-start": "Chat's head start",
  repairing: "CODEX at work",
  validating: "Replay tests",
  swapping: "Applying fix",
  resolved: "Round complete",
  "rolled-back": "Rolled back",
};
type Credentials = { url: string; token: string | null; code: string | null };
type LiveModule = { update: (json: string) => Promise<void> };
// Expo's DOM types omit RN's verified third constructor argument (native headers).
const NativeWebSocket = WebSocket as unknown as {
  new (
    url: string,
    protocols: undefined,
    options: { headers: Record<string, string> },
  ): WebSocket;
};
let nativeQueue: Promise<void> = Promise.resolve();
function updateNative(payload: object): Promise<void> {
  // ActivityKit requests and notification updates remain in event order.
  nativeQueue = nativeQueue
    .catch(() => {})
    .then(() =>
      requireNativeModule<LiveModule>("PitWallLive").update(
        JSON.stringify(payload),
      ),
    );
  return nativeQueue;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function Button({
  title,
  onPress,
  disabled = false,
  orange = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  orange?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        backgroundColor: orange ? clay.orange : clay.blue,
        opacity: disabled ? 0.4 : 1,
        padding: 18,
        borderRadius: 18,
        minHeight: 56,
      }}
    >
      <Text
        style={{
          color: "white",
          fontSize: 19,
          fontWeight: "800",
          textAlign: "center",
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export default function App() {
  useKeepAwake();
  const [state, dispatch] = useReducer(phoneReducer, initialPhoneState);
  const latest = useRef(state);
  latest.current = state;
  const [host, setHost] = useState("");
  const [code, setCode] = useState("");
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [notificationWarning, setNotificationWarning] = useState<string | null>(
    null,
  );
  const [nativeWarning, setNativeWarning] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const credentialRef = useRef<Credentials | null>(null);
  const actionNumber = useRef(0);
  const actionInFlight = useRef(false);
  const lastAlert = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(KEY)
      .then((value) => {
        if (!active || !value) return;
        const saved: unknown = JSON.parse(value);
        if (
          saved &&
          typeof saved === "object" &&
          "url" in saved &&
          "token" in saved &&
          typeof saved.url === "string" &&
          typeof saved.token === "string" &&
          /^[a-f0-9]{64}$/.test(saved.token)
        ) {
          const savedHost = saved.url
            .replace(/^ws:\/\//, "")
            .replace(/:4318$/, "");
          if (gatewayUrl(savedHost) !== saved.url) return;
          setHost(savedHost);
          setCredentials({ url: saved.url, token: saved.token, code: null });
        }
      })
      .catch(() => {
        if (active)
          dispatch({
            type: "message",
            message: "Could not read pairing. Pair again.",
          });
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    const clock = setInterval(() => setNow(Date.now()), 200);
    return () => {
      active = false;
      clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    if (!credentials) return;
    credentialRef.current = { ...credentials };
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let connection: WebSocket | null = null;
    let stopped = false;
    const start = () => {
      if (!active || stopped || AppState.currentState !== "active") return;
      if (connection && connection.readyState < WebSocket.CLOSING) return;
      dispatch({ type: "connecting" });
      // Android otherwise inserts an HTTP Origin. Browsers cannot set this
      // reserved header; pairing code/token remain the actual authorization.
      const ws = new NativeWebSocket(credentials.url, undefined, {
        headers: { Origin: "pit-wall-native" },
      });
      connection = ws;
      socket.current = ws;
      const owns = () => active && connection === ws;
      const refreshWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          if (owns()) ws.close();
        }, 35_000);
      };
      refreshWatchdog();
      ws.onopen = () => {
        if (!owns()) return;
        dispatch({ type: "opened" });
        const auth = credentialRef.current;
        ws.send(
          JSON.stringify(
            auth?.token
              ? { type: "auth", token: auth.token }
              : { type: "pair", code: auth?.code ?? "" },
          ),
        );
      };
      ws.onmessage = (event) => {
        if (
          !owns() ||
          typeof event.data !== "string" ||
          event.data.length > 8192
        )
          return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        const frame = parseServerFrame(parsed);
        if (!frame) return;
        refreshWatchdog();
        if (frame.type === "paired") {
          credentialRef.current = {
            url: credentials.url,
            token: frame.token,
            code: null,
          };
          setCode("");
          void SecureStore.setItemAsync(
            KEY,
            JSON.stringify({ url: credentials.url, token: frame.token }),
            {
              keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            },
          ).catch(() => {
            if (owns())
              dispatch({
                type: "message",
                message:
                  "Pairing works for this session; phone storage failed.",
              });
          });
        }
        if (frame.type === "ack") actionInFlight.current = false;
        if (frame.type === "error") {
          // Auth errors need a new terminal code. Retrying the same credential
          // would just create an endless rejected connection loop.
          stopped = true;
          ws.close();
        }
        dispatch({ type: "frame", frame, receivedAt: Date.now() });
      };
      ws.onerror = () => {
        if (owns()) ws.close();
      };
      ws.onclose = () => {
        if (!owns()) return;
        clearTimeout(watchdog);
        actionInFlight.current = false;
        socket.current = null;
        dispatch({
          type: "disconnected",
          reason: stopped
            ? "Pair again with the terminal code."
            : "Disconnected. Reconnecting...",
        });
        if (!stopped && credentialRef.current?.token)
          retry = setTimeout(start, 2000);
      };
    };
    start();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") start();
      else connection?.close();
    });
    return () => {
      active = false;
      clearTimeout(retry);
      clearTimeout(watchdog);
      subscription.remove();
      connection?.close();
      socket.current = null;
      actionInFlight.current = false;
    };
  }, [credentials]);

  useEffect(() => {
    if (!state.alertRoundId || lastAlert.current === state.alertRoundId) return;
    lastAlert.current = state.alertRoundId;
    void Haptics.notificationAsync(
      Haptics.NotificationFeedbackType.Warning,
    ).catch(() =>
      setNotificationWarning("Haptics unavailable on this device."),
    );
    void Notifications.scheduleNotificationAsync({
      identifier: `pit-wall-bug-${state.alertRoundId}`,
      content: {
        title: "Chat broke something",
        body: `Round ${state.round?.number ?? ""}`,
        sound: "default",
      },
      trigger:
        Platform.OS === "android" ? { channelId: "pit-wall-bugs" } : null,
    }).catch(() =>
      setNotificationWarning(
        "Notifications unavailable. Check phone settings.",
      ),
    );
  }, [state.alertRoundId, state.round?.number]);

  useEffect(() => {
    const payload = nativePayload(state, AppState.currentState === "active");
    if (!payload) return;
    void updateNative(payload)
      .then(() => setNativeWarning(null))
      .catch(() =>
        setNativeWarning(
          "Live status unavailable. Open the development build.",
        ),
      );
  }, [state]);

  useEffect(() => {
    if (!state.pending) {
      actionInFlight.current = false;
      return;
    }
    const timeout = setTimeout(() => {
      actionInFlight.current = false;
      socket.current?.close();
      dispatch({
        type: "disconnected",
        reason: "No action receipt. Check the runner before retrying.",
      });
    }, 8000);
    return () => clearTimeout(timeout);
  }, [state.pending]);

  const pair = () => {
    const url = gatewayUrl(host);
    if (!url || !/^\d{6}$/.test(code)) {
      dispatch({
        type: "message",
        message: "Enter the Mac's LAN IPv4 and six-digit code.",
      });
      return;
    }
    void Notifications.setNotificationChannelAsync("pit-wall-bugs", {
      name: "Bug alerts",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      vibrationPattern: [0, 200, 120, 200],
    })
      .then(() => Notifications.requestPermissionsAsync())
      .then((permissions) => {
        setNotificationWarning(
          permissions.granted
            ? null
            : "Notifications off. Enable in phone settings.",
        );
      })
      .catch(() => setNotificationWarning("Could not request notifications."))
      .finally(() => {
        // Finish the permission prompt before an active round can arrive.
        dispatch({ type: "forget" });
        setCredentials({ url, code, token: null });
      });
  };
  const sendAction = (kind: "veto" | "hint", family?: BugFamily) => {
    const current = latest.current;
    const ws = socket.current;
    if (
      actionInFlight.current ||
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      !current.round?.roundId ||
      (kind === "veto" ? !canVeto(current) : !canHint(current))
    )
      return;
    const id = `phone-${Date.now()}-${++actionNumber.current}`;
    const base = {
      type: "action" as const,
      id,
      roundId: current.round.roundId,
    };
    const frame: Action =
      kind === "veto"
        ? { ...base, action: "veto" }
        : { ...base, action: "hint", family: family ?? "gravity-sign" };
    actionInFlight.current = true;
    dispatch({ type: "pending", id, roundId: current.round.roundId });
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      ws.close();
      dispatch({ type: "disconnected", reason: "Action not sent." });
    }
  };
  const disconnect = () => {
    setCredentials(null);
    credentialRef.current = null;
    dispatch({ type: "forget" });
    void SecureStore.deleteItemAsync(KEY).catch(() =>
      dispatch({
        type: "message",
        message: "Could not remove pairing from phone storage.",
      }),
    );
  };
  const round = state.round;
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: clay.paper }}>
        <StatusBar barStyle="dark-content" />
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            padding: 24,
            paddingTop: 24,
            paddingBottom: 48,
            gap: 22,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <Text style={{ color: clay.ink, fontSize: 28, fontWeight: "900" }}>
              PIT WALL
            </Text>
            <Text
              accessibilityLiveRegion="polite"
              style={{
                color: state.connection === "live" ? clay.blue : clay.ink,
                fontWeight: "700",
              }}
            >
              {state.connection.toUpperCase()}
            </Text>
          </View>
          {state.connection !== "live" && (
            <View style={{ gap: 14 }}>
              <Text style={{ color: clay.ink, fontSize: 18 }}>
                Trusted Wi-Fi only. Pairing travels unencrypted on your LAN.
              </Text>
              <TextInput
                accessibilityLabel="Mac LAN IPv4 address"
                placeholder="Mac IPv4: 192.168.1.20"
                value={host}
                onChangeText={setHost}
                keyboardType="decimal-pad"
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  backgroundColor: clay.card,
                  padding: 18,
                  borderRadius: 16,
                  fontSize: 21,
                  color: clay.ink,
                }}
              />
              <TextInput
                accessibilityLabel="Six-digit terminal pairing code"
                placeholder="Terminal code"
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                maxLength={6}
                secureTextEntry
                style={{
                  backgroundColor: clay.card,
                  padding: 18,
                  borderRadius: 16,
                  fontSize: 24,
                  color: clay.ink,
                }}
              />
              <Button
                title={loaded ? "Pair phone" : "Loading..."}
                disabled={!loaded}
                onPress={pair}
              />
            </View>
          )}
          {round && (
            <>
              <View style={{ flexDirection: "row", gap: 12 }}>
                {[
                  { name: "CHAT", score: round.chat, color: clay.orange },
                  { name: "CODEX", score: round.codex, color: clay.blue },
                ].map((team) => (
                  <View
                    key={team.name}
                    style={{
                      flex: 1,
                      backgroundColor: team.color,
                      borderRadius: 24,
                      padding: 22,
                    }}
                  >
                    <Text
                      style={{
                        color: "white",
                        fontSize: 19,
                        fontWeight: "900",
                      }}
                    >
                      {team.name}
                    </Text>
                    <Text
                      style={{
                        color: "white",
                        fontSize: 64,
                        fontWeight: "900",
                      }}
                    >
                      {team.score}
                    </Text>
                  </View>
                ))}
              </View>
              <Text
                style={{ color: clay.ink, fontSize: 19, fontWeight: "700" }}
              >
                ROUND {round.number} / DEATHS {round.deaths}
              </Text>
              <View
                style={{
                  backgroundColor: clay.card,
                  borderRadius: 24,
                  padding: 24,
                  gap: 12,
                }}
              >
                <Text
                  style={{ fontSize: 19, fontWeight: "700", color: clay.ink }}
                >
                  {state.connection === "live"
                    ? phaseLabels[round.phase]
                    : "Last received"}
                </Text>
                {round.phase === "head-start" &&
                  state.connection === "live" && (
                    <Text
                      style={{
                        fontSize: 76,
                        color: clay.orange,
                        fontWeight: "900",
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {countdownSeconds(state, now)}s
                    </Text>
                  )}
                <Text
                  style={{
                    color: round.bug === "active" ? clay.orange : clay.blue,
                    fontWeight: "900",
                    fontSize: 30,
                  }}
                >
                  {round.bug === "active"
                    ? "BUG IN"
                    : round.bug === "fixed"
                      ? "FIX IN"
                      : "Waiting"}
                </Text>
                {round.bugName && (
                  <Text style={{ color: clay.ink, fontSize: 19 }}>
                    {round.bugName}
                  </Text>
                )}
                {round.step && (
                  <Text
                    style={{
                      color: clay.blue,
                      fontSize: 24,
                      fontWeight: "700",
                    }}
                  >
                    {round.step}
                  </Text>
                )}
                {round.headline && (
                  <Text
                    accessibilityLiveRegion="polite"
                    style={{ color: clay.ink, fontSize: 28, fontWeight: "900" }}
                  >
                    {round.headline}
                  </Text>
                )}
              </View>
              <Button
                title="Veto round"
                orange
                disabled={!canVeto(state)}
                onPress={() => sendAction("veto")}
              />
              <View style={{ gap: 10 }}>
                <Text
                  style={{ color: clay.ink, fontSize: 19, fontWeight: "800" }}
                >
                  Hint to CODEX
                </Text>
                <View
                  style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}
                >
                  {BUG_FAMILIES.map((family) => (
                    <View key={family} style={{ width: "48%" }}>
                      <Button
                        title={labels[family]}
                        disabled={!canHint(state)}
                        onPress={() => sendAction("hint", family)}
                      />
                    </View>
                  ))}
                </View>
              </View>
            </>
          )}
          {state.message && (
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: clay.ink, fontSize: 18 }}
            >
              {state.message}
            </Text>
          )}
          {notificationWarning && (
            <Text style={{ color: clay.orange }}>{notificationWarning}</Text>
          )}
          {nativeWarning && (
            <Text style={{ color: clay.orange }}>{nativeWarning}</Text>
          )}
          {credentials && (
            <Button title="Forget pairing" onPress={disconnect} />
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

import type { Action, BugFamily } from "@chat-vs-codex/pit-wall/protocol";
import { parseServerFrame } from "@chat-vs-codex/pit-wall/protocol";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { requireNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { useEffect, useReducer, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { PitWallScreen } from "./src/screen";
import {
  canHint,
  canVeto,
  gatewayUrl,
  initialPhoneState,
  nativePayload,
  phoneReducer,
} from "./src/state";

const KEY = "pit-wall-pairing";
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

export default function App() {
  return (
    <SafeAreaProvider>
      <ConnectedPitWall />
    </SafeAreaProvider>
  );
}

function ConnectedPitWall() {
  const insets = useSafeAreaInsets();
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
  return (
    <PitWallScreen
      state={state}
      now={now}
      insets={insets}
      host={host}
      code={code}
      loaded={loaded}
      credentialsPresent={credentials !== null}
      notificationWarning={notificationWarning}
      nativeWarning={nativeWarning}
      pair={pair}
      disconnect={disconnect}
      setHost={setHost}
      setCode={setCode}
      sendAction={sendAction}
    />
  );
}

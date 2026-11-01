import type { BugFamily } from "@chat-vs-codex/pit-wall/protocol";
import { BUG_FAMILIES } from "@chat-vs-codex/pit-wall/protocol";
import {
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  TextInput,
  View,
} from "react-native";
import { canHint, canVeto, countdownSeconds, type PhoneState } from "./state";

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
const hintRows = [
  BUG_FAMILIES.slice(0, 2),
  BUG_FAMILIES.slice(2, 4),
  BUG_FAMILIES.slice(4, 6),
];
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

export interface PitWallScreenProps {
  state: PhoneState;
  now: number;
  insets: { top: number; right: number; bottom: number; left: number };
  host: string;
  code: string;
  loaded: boolean;
  credentialsPresent: boolean;
  notificationWarning: string | null;
  nativeWarning: string | null;
  pair: () => void;
  disconnect: () => void;
  setHost: (host: string) => void;
  setCode: (code: string) => void;
  sendAction: (kind: "veto" | "hint", family?: BugFamily) => void;
}

function Button({
  title,
  onPress,
  disabled = false,
  orange = false,
  testID,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  orange?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        backgroundColor: orange ? clay.orange : clay.blue,
        opacity: disabled ? 0.4 : 1,
        paddingVertical: 13,
        paddingHorizontal: 10,
        borderRadius: 18,
        minHeight: 48,
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          color: "white",
          fontSize: 19,
          lineHeight: 22,
          fontWeight: "800",
          textAlign: "center",
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function PitWallScreen({
  state,
  now,
  insets,
  host,
  code,
  loaded,
  credentialsPresent,
  notificationWarning,
  nativeWarning,
  pair,
  disconnect,
  setHost,
  setCode,
  sendAction,
}: PitWallScreenProps) {
  const round = state.round;
  const active =
    state.connection === "live" &&
    !!round?.roundId &&
    ["preparing", "head-start", "repairing", "validating", "swapping"].includes(
      round.phase,
    );
  const detail = round?.headline || round?.step || round?.bugName;
  return (
    <View style={{ flex: 1, backgroundColor: clay.paper }}>
      <StatusBar barStyle="dark-content" />
      <ScrollView
        testID="pit-wall-scroll"
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        automaticallyAdjustsScrollIndicatorInsets={false}
        scrollIndicatorInsets={{ top: insets.top, bottom: insets.bottom }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingLeft: insets.left + 20,
          paddingRight: insets.right + 20,
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 16,
          gap: 10,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              color: clay.ink,
              fontSize: 28,
              lineHeight: 32,
              fontWeight: "900",
            }}
          >
            PIT WALL
          </Text>
          <Text
            numberOfLines={1}
            accessibilityLiveRegion="polite"
            style={{
              color: state.connection === "live" ? clay.blue : clay.ink,
              lineHeight: 22,
              fontWeight: "700",
            }}
          >
            {state.connection.toUpperCase()}
          </Text>
        </View>
        {state.connection !== "live" && (
          <View style={{ gap: 14 }}>
            <Text style={{ color: clay.ink, fontSize: 18, lineHeight: 24 }}>
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
                lineHeight: 26,
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
                lineHeight: 28,
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
                    padding: 12,
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      color: "white",
                      fontSize: 19,
                      lineHeight: 22,
                      fontWeight: "900",
                    }}
                  >
                    {team.name}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={{
                      color: "white",
                      fontSize: 48,
                      lineHeight: 56,
                      fontWeight: "900",
                    }}
                  >
                    {team.score}
                  </Text>
                </View>
              ))}
            </View>
            <Text
              numberOfLines={1}
              style={{
                color: clay.ink,
                fontSize: 19,
                lineHeight: 22,
                fontWeight: "700",
              }}
            >
              ROUND {round.number} / DEATHS {round.deaths}
            </Text>
            <View
              style={{
                backgroundColor: clay.card,
                borderRadius: 24,
                padding: 14,
                gap: 4,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 19,
                  lineHeight: 22,
                  fontWeight: "700",
                  color: clay.ink,
                }}
              >
                {state.connection === "live"
                  ? phaseLabels[round.phase]
                  : "Last received"}
              </Text>
              {round.phase === "head-start" && state.connection === "live" && (
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 60,
                    lineHeight: 64,
                    color: clay.orange,
                    fontWeight: "900",
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {countdownSeconds(state, now)}s
                </Text>
              )}
              <Text
                numberOfLines={1}
                style={{
                  color: round.bug === "active" ? clay.orange : clay.blue,
                  fontWeight: "900",
                  fontSize: 26,
                  lineHeight: 32,
                }}
              >
                {round.bug === "active"
                  ? "BUG IN"
                  : round.bug === "fixed"
                    ? "FIX IN"
                    : "Waiting"}
              </Text>
              {!!detail && (
                <Text
                  numberOfLines={2}
                  accessibilityLiveRegion={round.headline ? "polite" : "none"}
                  style={{
                    color: round.step && !round.headline ? clay.blue : clay.ink,
                    fontSize: 19,
                    lineHeight: 22,
                    fontWeight: round.headline || round.step ? "700" : "400",
                  }}
                >
                  {detail}
                </Text>
              )}
            </View>
            <Button
              testID="veto"
              title="Veto round"
              orange
              disabled={!canVeto(state)}
              onPress={() => sendAction("veto")}
            />
            <View style={{ gap: 6 }}>
              <Text
                numberOfLines={1}
                style={{
                  color: clay.ink,
                  fontSize: 19,
                  lineHeight: 22,
                  fontWeight: "800",
                }}
              >
                Hint to CODEX
              </Text>
              <View style={{ gap: 8 }}>
                {hintRows.map((families) => (
                  <View
                    key={families[0]}
                    style={{ flexDirection: "row", gap: 8 }}
                  >
                    {families.map((family) => (
                      <View key={family} style={{ flex: 1 }}>
                        <Button
                          testID={`hint-${family}`}
                          title={labels[family]}
                          disabled={!canHint(state)}
                          onPress={() => sendAction("hint", family)}
                        />
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            </View>
          </>
        )}
        {state.message && (
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: clay.ink, fontSize: 18, lineHeight: 24 }}
          >
            {state.message}
          </Text>
        )}
        {notificationWarning && (
          <Text style={{ color: clay.orange, lineHeight: 22 }}>
            {notificationWarning}
          </Text>
        )}
        {nativeWarning && (
          <Text style={{ color: clay.orange, lineHeight: 22 }}>
            {nativeWarning}
          </Text>
        )}
        {credentialsPresent && !active && (
          <Button
            testID="forget-pairing"
            title="Forget pairing"
            onPress={disconnect}
          />
        )}
      </ScrollView>
    </View>
  );
}

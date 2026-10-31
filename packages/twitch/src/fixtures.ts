import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Payloads, TwitchEvent, TwitchHandler } from "./events.js";

const required: Record<keyof Payloads, string[]> = {
  "channel.chat.message": [
    "broadcaster_user_id",
    "chatter_user_id",
    "message_id",
  ],
  "user.whisper.message": ["to_user_id", "from_user_id", "whisper_id"],
  "channel.channel_points_custom_reward_redemption.add": [
    "broadcaster_user_id",
    "user_id",
    "id",
    "status",
  ],
  "channel.custom_power_up_redemption.add": [
    "broadcaster_user_id",
    "user_id",
    "id",
    "status",
  ],
  "channel.bits.use": ["broadcaster_user_id", "user_id", "type"],
  "channel.raid": ["to_broadcaster_user_id", "from_broadcaster_user_id"],
  "channel.hype_train.begin": ["broadcaster_user_id", "id"],
  "channel.hype_train.progress": ["broadcaster_user_id", "id"],
  "channel.hype_train.end": ["broadcaster_user_id", "id"],
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseFixture(value: unknown): TwitchEvent {
  if (
    !record(value) ||
    typeof value.type !== "string" ||
    !Object.hasOwn(required, value.type) ||
    !record(value.event)
  )
    throw new Error("Invalid Twitch fixture envelope.");
  const type = value.type as keyof Payloads;
  const data = value.event;
  if (
    !required[type].every(
      (key) => typeof data[key] === "string" && data[key] !== "",
    )
  )
    throw new Error(`Invalid ${type} fixture identifiers.`);
  const nested = (key: string, field: string) =>
    record(data[key]) && typeof data[key][field] === "string";
  if (
    (type === "channel.chat.message" && !nested("message", "text")) ||
    (type === "user.whisper.message" && !nested("whisper", "text")) ||
    (type === "channel.channel_points_custom_reward_redemption.add" &&
      !nested("reward", "id")) ||
    (type === "channel.custom_power_up_redemption.add" &&
      !nested("custom_power_up", "id")) ||
    (type.startsWith("channel.hype_train.") &&
      (!Number.isInteger(data.level) || (data.level as number) < 1)) ||
    (type === "channel.raid" &&
      (!Number.isInteger(data.viewers) || (data.viewers as number) < 0))
  )
    throw new Error(`Invalid ${type} fixture payload.`);
  return value as unknown as TwitchEvent;
}

/** No waits or synthetic activity. Events exercise the same handler used by EventSub. */
export function replayFixtures(
  values: readonly unknown[],
  handler: TwitchHandler,
): void {
  const events = values.map(parseFixture);
  for (const event of events) handler.handle(event);
}

/** User content is redacted, identities are stable HMACs, including nested replies. */
export function anonymize(event: TwitchEvent, salt: string): TwitchEvent {
  if (salt.length < 16)
    throw new Error("Recorder salt must contain at least 16 characters.");
  const hash = (value: string) =>
    `anon-${createHmac("sha256", salt).update(value).digest("hex").slice(0, 24)}`;
  const walk = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry));
    if (record(value))
      return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, walk(entry, name)]),
      );
    if (typeof value !== "string") return value;
    if (key === "id" || key.endsWith("_id") || /user_(login|name)$/.test(key))
      return value ? hash(value) : value;
    if (
      ["text", "user_input", "parent_message_body", "prompt", "title"].includes(
        key,
      )
    ) {
      if (
        event.type === "channel.chat.message" &&
        key === "text" &&
        /^!(break|hint)$/i.test(value.trim())
      )
        return value.trim();
      return "[redacted]";
    }
    return value;
  };
  return { type: event.type, event: walk(event.event) } as TwitchEvent;
}

export function createRecorder(
  path: string,
  salt: string,
): (event: TwitchEvent) => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return (event) =>
    appendFileSync(path, `${JSON.stringify(anonymize(event, salt))}\n`, {
      mode: 0o600,
    });
}

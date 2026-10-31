import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCommentary } from "../src/commentary.js";

const aws = vi.hoisted(() => ({
  config: vi.fn(),
  input: vi.fn(),
  send: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@aws-sdk/client-polly", () => ({
  PollyClient: class {
    constructor(config: unknown) {
      aws.config(config);
    }
    send = aws.send;
    destroy = aws.destroy;
  },
  SynthesizeSpeechCommand: class {
    constructor(input: unknown) {
      aws.input(input);
    }
  },
}));

it("loads the neural US East client lazily using its standard credential chain", async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "polly-client-"));
  aws.send.mockResolvedValue({
    AudioStream: (async function* () {
      yield new Uint8Array([1, 2, 3]);
    })(),
  });
  const event = {
    type: "game.build",
    phase: "broken",
    roundId: "round-one",
    buildId: "a".repeat(64),
    digest: "a".repeat(64),
  } as const;
  try {
    const off = createCommentary({ enabled: false, cacheDirectory });
    off.observe(event, () => {});
    await off.close();
    expect(aws.config).not.toHaveBeenCalled();
    expect(aws.send).not.toHaveBeenCalled();
    const enabled = createCommentary({ enabled: true, cacheDirectory });
    expect(aws.config).not.toHaveBeenCalled();
    const emit = vi.fn();
    enabled.observe(event, emit);
    await enabled.drain();
    expect(aws.config).toHaveBeenCalledExactlyOnceWith({
      region: "us-east-1",
      maxAttempts: 1,
    });
    expect(aws.input).toHaveBeenCalledExactlyOnceWith({
      Engine: "neural",
      VoiceId: "Joanna",
      OutputFormat: "mp3",
      TextType: "text",
      Text: "Something broke.",
    });
    expect(aws.send.mock.calls[0]?.[1].abortSignal).toBeInstanceOf(AbortSignal);
    expect(emit).toHaveBeenCalledOnce();
    await enabled.close();
    expect(aws.destroy).toHaveBeenCalledOnce();
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

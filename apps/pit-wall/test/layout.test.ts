import {
  BUG_FAMILIES,
  initialState,
  type State,
} from "@chat-vs-codex/pit-wall/protocol";
import {
  Children,
  Fragment,
  type FunctionComponent,
  isValidElement,
  type ReactNode,
} from "react";
import { describe, expect, it, vi } from "vitest";
import Yoga from "yoga-layout";
import { PitWallScreen, type PitWallScreenProps } from "../src/screen";
import { initialPhoneState } from "../src/state";

type Node = ReturnType<typeof Yoga.Node.create>;
type Style = Record<string, unknown>;
type Props = {
  children?: ReactNode;
  style?: Style | Style[];
  contentContainerStyle?: Style;
  testID?: string;
  numberOfLines?: number;
  disabled?: boolean;
  onPress?: () => void;
  contentInsetAdjustmentBehavior?: string;
};
const inset = { top: 62, right: 0, bottom: 34, left: 0 };
const controls = ["veto", ...BUG_FAMILIES.map((family) => `hint-${family}`)];
const activePhases = [
  "preparing",
  "head-start",
  "repairing",
  "validating",
  "swapping",
] as const;
const noop = () => {};
const propsFor = (phase: State["phase"]): PitWallScreenProps => ({
  state: {
    ...initialPhoneState,
    connection: "live",
    round: {
      ...initialState(),
      roundId: "round-1",
      number: 1,
      phase,
      bug: "active",
      deaths: 999,
      chat: 999,
      codex: 999,
      headStartEndsAt: 16_000,
      bugName: "A long bug name that needs both available detail lines",
      step:
        phase === "repairing"
          ? "A real Codex step that needs both available detail lines"
          : null,
      headline:
        phase === "resolved"
          ? "An autopsy headline that needs both available detail lines"
          : null,
    },
  },
  now: 1000,
  insets: inset,
  host: "",
  code: "",
  loaded: true,
  credentialsPresent: true,
  notificationWarning: null,
  nativeWarning: null,
  pair: noop,
  disconnect: noop,
  setHost: noop,
  setCode: noop,
  sendAction: noop,
});

// Yoga lays out the real screen tree. Text uses its explicit lineHeight and the
// maximum numberOfLines, a conservative height bound rather than native glyphs.
function layout(
  props: PitWallScreenProps,
  height = 874,
  fontScale = 1,
  extraGap = 0,
) {
  const ids = new Map<string, { node: Node; props: Props }>();
  let content: Node | undefined;
  let scroll: Node | undefined;
  let scrollProps: Props | undefined;
  const decorative = new Set([
    "backgroundColor",
    "borderRadius",
    "opacity",
    "color",
    "fontSize",
    "lineHeight",
    "fontWeight",
    "textAlign",
    "fontVariant",
  ]);
  const styleNode = (node: Node, style: Style) => {
    for (const [key, value] of Object.entries(style)) {
      if (decorative.has(key)) continue;
      const number = () => {
        if (typeof value !== "number")
          throw new Error(`Unsupported ${key}: ${value}`);
        return value;
      };
      if (key === "flex") node.setFlex(number());
      else if (key === "minHeight") node.setMinHeight(number());
      else if (key === "flexDirection") {
        if (value !== "row" && value !== "column")
          throw new Error(`Unsupported ${key}`);
        node.setFlexDirection(
          value === "row"
            ? Yoga.FLEX_DIRECTION_ROW
            : Yoga.FLEX_DIRECTION_COLUMN,
        );
      } else if (key === "alignItems") {
        if (value !== "center") throw new Error(`Unsupported ${key}`);
        node.setAlignItems(Yoga.ALIGN_CENTER);
      } else if (key === "justifyContent") {
        if (value !== "space-between") throw new Error(`Unsupported ${key}`);
        node.setJustifyContent(Yoga.JUSTIFY_SPACE_BETWEEN);
      } else if (key === "gap")
        node.setGap(Yoga.GUTTER_ALL, number() + extraGap);
      else if (key.startsWith("padding")) {
        const edges = {
          padding: Yoga.EDGE_ALL,
          paddingHorizontal: Yoga.EDGE_HORIZONTAL,
          paddingVertical: Yoga.EDGE_VERTICAL,
          paddingLeft: Yoga.EDGE_LEFT,
          paddingRight: Yoga.EDGE_RIGHT,
          paddingTop: Yoga.EDGE_TOP,
          paddingBottom: Yoga.EDGE_BOTTOM,
        };
        const edge = edges[key as keyof typeof edges];
        if (edge === undefined) throw new Error(`Unsupported ${key}`);
        node.setPadding(edge, number());
      } else throw new Error(`Layout harness must support ${key}`);
    }
  };
  const expand = (child: ReactNode): Node[] =>
    Children.toArray(child).flatMap((item) => {
      if (!isValidElement<Props>(item))
        throw new Error("Text must be inside Text");
      if (item.type === Fragment) return expand(item.props.children);
      if (typeof item.type === "function")
        return expand(
          (item.type as FunctionComponent<Props>)(item.props) as ReactNode,
        );
      if (item.type === "StatusBar") return [];
      const node = Yoga.Node.create();
      node.setFlexDirection(Yoga.FLEX_DIRECTION_COLUMN);
      node.setFlexShrink(0); // React Native defaults differ from web flexbox.
      const style = Object.assign(
        {},
        ...[item.props.style].flat().filter(Boolean),
      ) as Style;
      styleNode(node, style);
      if (item.props.testID)
        ids.set(item.props.testID, { node, props: item.props });
      if (item.type === "Text") {
        if (typeof style.lineHeight !== "number")
          throw new Error("Explicit lineHeight required");
        const lineHeight = style.lineHeight * fontScale;
        const lines = item.props.numberOfLines ?? 2;
        const text = Children.toArray(item.props.children).join("");
        node.setMeasureFunc((width, mode) => {
          const intrinsicWidth = text.length * lineHeight * 0.55;
          return {
            width:
              mode === Yoga.MEASURE_MODE_UNDEFINED
                ? intrinsicWidth
                : mode === Yoga.MEASURE_MODE_EXACTLY
                  ? width
                  : Math.min(width, intrinsicWidth),
            height: lineHeight * lines,
          };
        });
      } else if (item.type === "ScrollView") {
        scroll = node;
        scrollProps = item.props;
        node.setFlexGrow(1);
        node.setFlexShrink(1);
        node.setOverflow(Yoga.OVERFLOW_SCROLL);
        content = Yoga.Node.create();
        content.setFlexShrink(0);
        styleNode(content, item.props.contentContainerStyle ?? {});
        node.insertChild(content, 0);
        for (const nested of expand(item.props.children))
          content.insertChild(nested, content.getChildCount());
      } else {
        for (const nested of expand(item.props.children))
          node.insertChild(nested, node.getChildCount());
      }
      return [node];
    });
  const root = expand(PitWallScreen(props))[0];
  if (!root) throw new Error("Screen root missing");
  root.calculateLayout(402, height, Yoga.DIRECTION_LTR);
  if (!content || !scroll || !scrollProps)
    throw new Error("Scroll content missing");
  const bounds = (id: string) => {
    const entry = ids.get(id);
    if (!entry) throw new Error(`Missing control ${id}`);
    let top = 0;
    for (
      let current: Node | null = entry.node;
      current;
      current = current.getParent()
    )
      top += current.getComputedTop();
    return {
      top,
      bottom: top + entry.node.getComputedHeight(),
      height: entry.node.getComputedHeight(),
    };
  };
  return {
    ids,
    bounds,
    content,
    scroll,
    scrollProps,
    free: () => root.freeRecursive(),
  };
}

describe("Pit Wall safe viewport", () => {
  it.each(activePhases)(
    "keeps all round controls visible at 402x874 during %s",
    (phase) => {
      const rendered = layout(propsFor(phase));
      try {
        for (const id of controls) {
          const bounds = rendered.bounds(id);
          expect(bounds.top, id).toBeGreaterThanOrEqual(inset.top);
          expect(bounds.bottom, id).toBeLessThanOrEqual(874 - inset.bottom);
          expect(bounds.height, id).toBeGreaterThanOrEqual(48);
          expect(rendered.ids.get(id)?.props.disabled).toBe(
            !["preparing", "head-start"].includes(phase),
          );
        }
        expect(rendered.content.getComputedHeight()).toBeLessThanOrEqual(874);
        expect(rendered.ids.has("forget-pairing")).toBe(false);
      } finally {
        rendered.free();
      }
    },
  );

  it("keeps controls above receipts and warnings", () => {
    const props = propsFor("head-start");
    props.state.message = "Accepted";
    props.notificationWarning = "Notifications unavailable";
    props.nativeWarning = "Live Activity unavailable";
    const rendered = layout(props);
    try {
      for (const id of controls)
        expect(rendered.bounds(id).bottom, id).toBeLessThanOrEqual(840);
    } finally {
      rendered.free();
    }
  });

  it("wires Veto and each family button to the streamer action", () => {
    const props = propsFor("head-start");
    const sendAction = vi.fn();
    props.sendAction = sendAction;
    const rendered = layout(props);
    try {
      rendered.ids.get("veto")?.props.onPress?.();
      for (const family of BUG_FAMILIES)
        rendered.ids.get(`hint-${family}`)?.props.onPress?.();
      expect(sendAction.mock.calls).toEqual([
        ["veto"],
        ...BUG_FAMILIES.map((family) => ["hint", family]),
      ]);
    } finally {
      rendered.free();
    }
  });

  it("reserves an explicit bottom safe area, including a larger inset", () => {
    const props = propsFor("resolved");
    props.insets = { ...inset, bottom: 72 };
    const rendered = layout(props);
    try {
      expect(rendered.scrollProps.contentInsetAdjustmentBehavior).toBe("never");
      expect(
        rendered.content.getComputedPadding(Yoga.EDGE_BOTTOM),
      ).toBeGreaterThanOrEqual(72 + 16);
    } finally {
      rendered.free();
    }
  });

  it.each(["idle", "resolved"] as const)(
    "makes Forget pairing fully reachable at max scroll during %s",
    (phase) => {
      const rendered = layout(propsFor(phase), 650, 1.5);
      try {
        const maxScroll =
          rendered.content.getComputedHeight() -
          rendered.scroll.getComputedHeight();
        expect(maxScroll).toBeGreaterThan(0);
        const forget = rendered.bounds("forget-pairing");
        expect(forget.top - maxScroll).toBeGreaterThanOrEqual(inset.top);
        expect(forget.bottom - maxScroll).toBeLessThanOrEqual(
          650 - inset.bottom,
        );
      } finally {
        rendered.free();
      }
    },
  );

  it("keeps the last hint above the safe area at max scroll with larger text", () => {
    const rendered = layout(propsFor("head-start"), 650, 1.5);
    try {
      const maxScroll =
        rendered.content.getComputedHeight() -
        rendered.scroll.getComputedHeight();
      expect(maxScroll).toBeGreaterThan(0);
      const last = rendered.bounds(controls[controls.length - 1] ?? "missing");
      expect(last.top - maxScroll).toBeGreaterThanOrEqual(inset.top);
      expect(last.bottom - maxScroll).toBeLessThanOrEqual(650 - inset.bottom);
    } finally {
      rendered.free();
    }
  });

  it("detects the overflow when generous spacing returns", () => {
    const rendered = layout(propsFor("head-start"), 874, 1, 12);
    try {
      expect(controls.some((id) => rendered.bounds(id).bottom > 840)).toBe(
        true,
      );
    } finally {
      rendered.free();
    }
  });
});

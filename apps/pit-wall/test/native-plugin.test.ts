import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const withPitWallLive = require("../plugins/withPitWallLive.cjs");
const xcode = require(
  require.resolve("xcode", {
    paths: [dirname(require.resolve("expo/config-plugins"))],
  }),
);

// Minimal real PBX project, parsed and serialized by the same xcode library Expo uses.
const fixture = `// !$*UTF8*$!
{
archiveVersion = 1;
classes = {};
objectVersion = 54;
objects = {
/* Begin PBXBuildFile section */
/* End PBXBuildFile section */
/* Begin PBXFileReference section */
A00000000000000000000001 /* PitWall.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; path = PitWall.app; sourceTree = BUILT_PRODUCTS_DIR; };
/* End PBXFileReference section */
/* Begin PBXGroup section */
A00000000000000000000002 = {isa = PBXGroup; children = (A00000000000000000000003 /* Products */,); sourceTree = "<group>"; };
A00000000000000000000003 /* Products */ = {isa = PBXGroup; children = (A00000000000000000000001 /* PitWall.app */,); name = Products; sourceTree = "<group>"; };
/* End PBXGroup section */
/* Begin PBXNativeTarget section */
A00000000000000000000004 /* PitWall */ = {isa = PBXNativeTarget; buildConfigurationList = A00000000000000000000007; buildPhases = (); buildRules = (); dependencies = (); name = PitWall; productName = PitWall; productReference = A00000000000000000000001; productType = "com.apple.product-type.application"; };
/* End PBXNativeTarget section */
/* Begin PBXProject section */
A00000000000000000000005 = {isa = PBXProject; attributes = {}; buildConfigurationList = A00000000000000000000008; compatibilityVersion = "Xcode 14.0"; mainGroup = A00000000000000000000002; productRefGroup = A00000000000000000000003; projectDirPath = ""; targets = (A00000000000000000000004 /* PitWall */,); };
/* End PBXProject section */
/* Begin XCBuildConfiguration section */
A00000000000000000000009 /* Debug */ = {isa = XCBuildConfiguration; buildSettings = {DEVELOPMENT_TEAM = TEAM123; MARKETING_VERSION = 2.0.0; CURRENT_PROJECT_VERSION = 7;}; name = Debug; };
A00000000000000000000010 /* Release */ = {isa = XCBuildConfiguration; buildSettings = {DEVELOPMENT_TEAM = TEAM123; MARKETING_VERSION = 2.0.0; CURRENT_PROJECT_VERSION = 7;}; name = Release; };
/* End XCBuildConfiguration section */
/* Begin XCConfigurationList section */
A00000000000000000000007 = {isa = XCConfigurationList; buildConfigurations = (A00000000000000000000009 /* Debug */,A00000000000000000000010 /* Release */,); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
A00000000000000000000008 = {isa = XCConfigurationList; buildConfigurations = (A00000000000000000000009 /* Debug */,A00000000000000000000010 /* Release */,); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release; };
/* End XCConfigurationList section */
};
rootObject = A00000000000000000000005;
}
`;

const folders: string[] = [];
function projectFixture() {
  const folder = mkdtempSync(join(tmpdir(), "pit-wall-widget-"));
  folders.push(folder);
  const file = join(folder, "project.pbxproj");
  writeFileSync(file, fixture);
  const project = xcode.project(file);
  project.parseSync();
  return { folder, file, project };
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("Pit Wall Live Activity config plugin", () => {
  it("creates, embeds and signs a widget target with both Swift sources", () => {
    const { folder, file, project } = projectFixture();
    withPitWallLive.configureWidgetTarget(
      project,
      { ios: { bundleIdentifier: "com.example.pitwall" } },
      folder,
    );
    writeFileSync(file, project.writeSync());
    const parsed = xcode.project(file);
    parsed.parseSync();
    const objects = parsed.hash.project.objects;
    const targetEntries = Object.entries(objects.PBXNativeTarget).filter(
      ([key]) => !key.endsWith("_comment"),
    );
    expect(targetEntries).toHaveLength(2);
    const widgetId = Object.keys(objects.PBXNativeTarget).find(
      (key) => objects.PBXNativeTarget[key]?.name === '"PitWallLiveWidget"',
    );
    expect(widgetId).toBeTruthy();
    const widget = objects.PBXNativeTarget[widgetId as string];
    const list = objects.XCConfigurationList[widget.buildConfigurationList];
    expect(list.buildConfigurations).toHaveLength(2);
    for (const entry of list.buildConfigurations) {
      expect(
        objects.XCBuildConfiguration[entry.value].buildSettings,
      ).toMatchObject({
        PRODUCT_BUNDLE_IDENTIFIER: '"com.example.pitwall.PitWallLiveWidget"',
        INFOPLIST_FILE: '"PitWallLiveWidget/Info.plist"',
        DEVELOPMENT_TEAM: "TEAM123",
        CURRENT_PROJECT_VERSION: 7,
        MARKETING_VERSION: "2.0.0",
        APPLICATION_EXTENSION_API_ONLY: "YES",
        SKIP_INSTALL: "YES",
      });
    }
    const phases = widget.buildPhases.map(
      (entry: { value: string }) => objects.PBXSourcesBuildPhase?.[entry.value],
    );
    const sources = phases.find((phase: unknown) => Boolean(phase));
    expect(sources.files).toHaveLength(2);
    for (const name of ["PitWallLiveWidget.swift", "PitWallAttributes.swift"]) {
      const refId = Object.keys(objects.PBXFileReference).find(
        (key) =>
          objects.PBXFileReference[key]?.path === `"PitWallLiveWidget/${name}"`,
      );
      expect(refId).toBeTruthy();
      expect(
        sources.files.some(
          (entry: { value: string }) =>
            objects.PBXBuildFile[entry.value].fileRef === refId,
        ),
      ).toBe(true);
      expect(
        readFileSync(join(folder, "PitWallLiveWidget", name), "utf8"),
      ).not.toBe("");
    }
    const app = parsed.getFirstTarget().firstTarget;
    expect(app.dependencies).toHaveLength(1);
    expect(objects.PBXTargetDependency[app.dependencies[0].value].target).toBe(
      widgetId,
    );
    const copyPhase = app.buildPhases
      .map(
        (entry: { value: string }) =>
          objects.PBXCopyFilesBuildPhase?.[entry.value],
      )
      .find((phase: unknown) => Boolean(phase));
    expect(copyPhase.dstSubfolderSpec).toBe(13);
    expect(copyPhase.files).toHaveLength(1);
    const embedded = objects.PBXBuildFile[copyPhase.files[0].value];
    expect(embedded.fileRef).toBe(widget.productReference);
    expect(embedded.settings.ATTRIBUTES).toContain("CodeSignOnCopy");
    expect(
      readFileSync(join(folder, "PitWallLiveWidget/Info.plist"), "utf8"),
    ).toContain("com.apple.widgetkit-extension");
  });

  it("can run twice without duplicate targets or embed phases and updates bundle identity", () => {
    const { folder, project } = projectFixture();
    const configure = (bundleIdentifier: string) =>
      withPitWallLive.configureWidgetTarget(
        project,
        { ios: { bundleIdentifier } },
        folder,
      );
    configure("com.example.first");
    configure("com.example.second");
    const raw = project.writeSync();
    expect(raw.match(/isa = PBXNativeTarget;/g)).toHaveLength(2);
    expect(raw.match(/isa = PBXCopyFilesBuildPhase;/g)).toHaveLength(1);
    expect(raw).not.toContain("com.example.first");
    expect(raw).toContain("com.example.second.PitWallLiveWidget");
  });

  it("advertises extension provisioning to EAS while keeping existing extras", () => {
    const result = withPitWallLive({
      name: "Pit Wall",
      slug: "pit-wall",
      ios: { bundleIdentifier: "com.example.pitwall" },
      extra: { eas: { projectId: "existing-id" }, keep: true },
    });
    expect(result.extra.keep).toBe(true);
    expect(result.extra.eas.projectId).toBe("existing-id");
    expect(result.extra.eas.build.experimental.ios.appExtensions).toEqual([
      {
        targetName: "PitWallLiveWidget",
        bundleIdentifier: "com.example.pitwall.PitWallLiveWidget",
        entitlements: {},
      },
    ]);
    const again = withPitWallLive(result);
    expect(again.extra.eas.build.experimental.ios.appExtensions).toHaveLength(
      1,
    );
  });

  it("requires the app bundle identifier", () => {
    const { folder, project } = projectFixture();
    expect(() =>
      withPitWallLive.configureWidgetTarget(project, {}, folder),
    ).toThrow("ios.bundleIdentifier");
  });
});

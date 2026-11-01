const fs = require("node:fs");
const path = require("node:path");
const {
  AndroidConfig,
  withAndroidManifest,
  withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");

const TARGET = "PitWallLiveWidget";
const unquote = (value) => String(value).replace(/^"|"$/g, "");

function writeWidgetFiles(platformProjectRoot) {
  const destination = path.join(platformProjectRoot, TARGET);
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "widget/PitWallLiveWidget.swift"),
    path.join(destination, "PitWallLiveWidget.swift"),
  );
  fs.copyFileSync(
    path.join(
      __dirname,
      "../modules/pit-wall-live/ios/PitWallAttributes.swift",
    ),
    path.join(destination, "PitWallAttributes.swift"),
  );
  fs.writeFileSync(
    path.join(destination, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Pit Wall</string>
<key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
<key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
<key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
<key>CFBundlePackageType</key><string>XPC!</string>
<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
<key>NSExtension</key><dict>
<key>NSExtensionPointIdentifier</key><string>com.apple.widgetkit-extension</string>
</dict>
</dict></plist>
`,
  );
}

function configureWidgetTarget(project, config, platformProjectRoot) {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (!bundleIdentifier) {
    throw new Error("Pit Wall Live Activity needs ios.bundleIdentifier");
  }
  writeWidgetFiles(platformProjectRoot);
  const targets = project.pbxNativeTargetSection();
  let targetId = Object.keys(targets).find(
    (id) => !id.endsWith("_comment") && unquote(targets[id].name) === TARGET,
  );
  if (!targetId) {
    // xcode.addTarget silently omits the host dependency if either section is absent.
    // A fresh Expo project has neither section until its first extension is added.
    project.hash.project.objects.PBXTargetDependency ??= {};
    project.hash.project.objects.PBXContainerItemProxy ??= {};
    const target = project.addTarget(
      TARGET,
      "app_extension",
      TARGET,
      `${bundleIdentifier}.${TARGET}`,
    );
    targetId = target.uuid;
    const sourceFiles = ["PitWallLiveWidget.swift", "PitWallAttributes.swift"];
    // File references are relative to this explicit group path, not the iOS root.
    const group = project.addPbxGroup(
      [...sourceFiles, "Info.plist"],
      TARGET,
      TARGET,
    );
    project.addToPbxGroup(
      group.uuid,
      project.getFirstProject().firstProject.mainGroup,
    );
    project.addBuildPhase(
      sourceFiles,
      "PBXSourcesBuildPhase",
      "Sources",
      targetId,
    );
    project.addBuildPhase(
      [],
      "PBXFrameworksBuildPhase",
      "Frameworks",
      targetId,
    );
    project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", targetId);
  }
  const target = targets[targetId];
  for (const [id, entry] of Object.entries(project.pbxBuildFileSection())) {
    if (!id.endsWith("_comment") && entry.fileRef === target.productReference) {
      entry.settings = {
        ...entry.settings,
        ATTRIBUTES: ["CodeSignOnCopy", "RemoveHeadersOnCopy"],
      };
    }
  }
  const list = project.pbxXCConfigurationList()[target.buildConfigurationList];
  const configurations = project.pbxXCBuildConfigurationSection();
  const appTarget = project.getFirstTarget().firstTarget;
  const appList =
    project.pbxXCConfigurationList()[appTarget.buildConfigurationList];
  for (const entry of list.buildConfigurations) {
    const item = configurations[entry.value];
    const appEntry = appList.buildConfigurations.find(
      (candidate) => configurations[candidate.value].name === item.name,
    );
    const appSettings = appEntry
      ? configurations[appEntry.value].buildSettings
      : {};
    Object.assign(item.buildSettings, {
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleIdentifier}.${TARGET}"`,
      PRODUCT_NAME: `"${TARGET}"`,
      INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
      IPHONEOS_DEPLOYMENT_TARGET: "16.4",
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: '"1,2"',
      APPLICATION_EXTENSION_API_ONLY: "YES",
      SKIP_INSTALL: "YES",
      CODE_SIGN_STYLE: "Automatic",
      GENERATE_INFOPLIST_FILE: "NO",
      MARKETING_VERSION:
        config.version ?? appSettings.MARKETING_VERSION ?? "1.0.0",
      CURRENT_PROJECT_VERSION:
        config.ios?.buildNumber ?? appSettings.CURRENT_PROJECT_VERSION ?? "1",
    });
    const team = config.ios?.appleTeamId ?? appSettings.DEVELOPMENT_TEAM;
    if (team) item.buildSettings.DEVELOPMENT_TEAM = team;
  }
  const firstProject = project.getFirstProject().firstProject;
  firstProject.attributes ??= {};
  firstProject.attributes.TargetAttributes ??= {};
  firstProject.attributes.TargetAttributes[targetId] = {
    ...firstProject.attributes.TargetAttributes[targetId],
    ProvisioningStyle: "Automatic",
  };
  return project;
}

function withPitWallLive(config) {
  // EAS must provision the extension before prebuild creates its native target.
  const extensions =
    config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  if (
    config.ios?.bundleIdentifier &&
    !extensions.some((entry) => entry.targetName === TARGET)
  ) {
    config.extra = {
      ...config.extra,
      eas: {
        ...config.extra?.eas,
        build: {
          ...config.extra?.eas?.build,
          experimental: {
            ...config.extra?.eas?.build?.experimental,
            ios: {
              ...config.extra?.eas?.build?.experimental?.ios,
              appExtensions: [
                ...extensions,
                {
                  targetName: TARGET,
                  bundleIdentifier: `${config.ios.bundleIdentifier}.${TARGET}`,
                  entitlements: {},
                },
              ],
            },
          },
        },
      },
    };
  }
  config = withInfoPlist(config, (mod) => {
    mod.modResults.NSSupportsLiveActivities = true;
    return mod;
  });
  config = withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(
      mod.modResults,
    );
    app.$["android:usesCleartextTraffic"] = "true";
    return mod;
  });
  return withXcodeProject(config, (mod) => {
    configureWidgetTarget(
      mod.modResults,
      mod,
      mod.modRequest.platformProjectRoot,
    );
    return mod;
  });
}

module.exports = withPitWallLive;
module.exports.configureWidgetTarget = configureWidgetTarget;

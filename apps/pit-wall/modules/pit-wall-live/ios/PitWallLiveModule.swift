import ActivityKit
import ExpoModulesCore
import Foundation

public class PitWallLiveModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PitWallLive")

    AsyncFunction("update") { (json: String) async throws in
      guard #available(iOS 16.2, *) else { return }
      let state = try JSONDecoder().decode(
        PitWallAttributes.ContentState.self, from: Data(json.utf8))
      try await PitWallActivityStore.shared.update(state)
    }
  }
}

@available(iOS 16.2, *)
private actor PitWallActivityStore {
  static let shared = PitWallActivityStore()

  func update(_ state: PitWallAttributes.ContentState) async throws {
    let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(60))
    for activity in Activity<PitWallAttributes>.activities {
      if !state.active || activity.attributes.roundId != state.roundId {
        await activity.end(content, dismissalPolicy: .immediate)
      }
    }
    guard state.active, ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    if let activity = Activity<PitWallAttributes>.activities.first(where: {
      $0.attributes.roundId == state.roundId
    }) {
      await activity.update(content)
    } else {
      _ = try Activity.request(
        attributes: PitWallAttributes(roundId: state.roundId), content: content, pushType: nil)
    }
  }
}

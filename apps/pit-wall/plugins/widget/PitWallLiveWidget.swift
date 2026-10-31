import ActivityKit
import SwiftUI
import WidgetKit

private let chatOrange = Color(red: 0.94, green: 0.43, blue: 0.24)
private let codexBlue = Color(red: 0.29, green: 0.56, blue: 0.84)

@main
struct PitWallWidgetBundle: WidgetBundle {
  var body: some Widget { PitWallLiveWidget() }
}

struct PitWallLiveWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PitWallAttributes.self) { context in
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text("CHAT \(context.state.chatScore)").foregroundStyle(chatOrange)
          Spacer()
          Text("\(context.state.codexScore) CODEX").foregroundStyle(codexBlue)
        }.font(.headline.monospacedDigit())
        PitWallStatus(state: context.state, stale: context.isStale)
          .font(.title3.bold()).lineLimit(2)
        Text("\(context.state.deaths) deaths").font(.caption)
      }
      .padding()
      .activityBackgroundTint(Color(red: 0.11, green: 0.10, blue: 0.09))
      .activitySystemActionForegroundColor(.white)
      .foregroundStyle(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Text("CHAT \(context.state.chatScore)").foregroundStyle(chatOrange)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text("\(context.state.codexScore) CODEX").foregroundStyle(codexBlue)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(spacing: 4) {
            PitWallStatus(state: context.state, stale: context.isStale)
              .font(.headline).lineLimit(2)
            Text("\(context.state.deaths) deaths").font(.caption)
          }
        }
      } compactLeading: {
        Text("\(context.state.chatScore)").foregroundStyle(chatOrange)
      } compactTrailing: {
        if context.isStale {
          Image(systemName: "wifi.slash")
        } else if let end = context.state.headStartEndsAt,
          end > Date().timeIntervalSince1970 * 1000 {
          Text(timerInterval: Date()...Date(timeIntervalSince1970: end / 1000), countsDown: true)
            .monospacedDigit().frame(maxWidth: 44)
        } else {
          Text("\(context.state.codexScore)").foregroundStyle(codexBlue)
        }
      } minimal: {
        Image(systemName: context.isStale ? "wifi.slash" : "bolt.fill")
          .foregroundStyle(codexBlue)
      }
      .keylineTint(codexBlue)
    }
  }
}

private struct PitWallStatus: View {
  let state: PitWallAttributes.ContentState
  let stale: Bool

  var body: some View {
    if stale {
      Text("Connection paused")
    } else if !state.headline.isEmpty {
      Text(state.headline)
    } else if let end = state.headStartEndsAt, end > Date().timeIntervalSince1970 * 1000 {
      HStack {
        Text("Head start")
        Text(timerInterval: Date()...Date(timeIntervalSince1970: end / 1000), countsDown: true)
          .monospacedDigit()
      }
    } else {
      Text(state.step.isEmpty ? state.phase : state.step)
    }
  }
}

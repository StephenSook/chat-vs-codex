import ActivityKit
import Foundation

@available(iOS 16.2, *)
struct PitWallAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    let active: Bool
    let roundId: String
    let phase: String
    let chatScore: Int
    let codexScore: Int
    let deaths: Int
    let headStartEndsAt: Double?
    let step: String
    let headline: String
  }

  let roundId: String
}

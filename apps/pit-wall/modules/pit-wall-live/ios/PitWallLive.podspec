Pod::Spec.new do |s|
  s.name = 'PitWallLive'
  s.version = '1.0.0'
  s.summary = 'Local Pit Wall round status'
  s.description = 'Updates ActivityKit from the paired app without remote push.'
  s.license = { :type => 'MIT' }
  s.author = 'Stephen Sookra'
  s.homepage = 'https://github.com/StephenSook/chat-vs-codex'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => 'https://github.com/StephenSook/chat-vs-codex.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ActivityKit'
  s.swift_version = '5.9'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end

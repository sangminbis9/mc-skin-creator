require 'xcodeproj'

path = 'app-store/ios/App/App.xcodeproj'
project = Xcodeproj::Project.open(path)
app = project.targets.find { |target| target.name == 'App' }
test = project.new_target(:ui_test_bundle, 'StoreCapture', :ios, '18.0')
test.add_dependency(app)
source = project.main_group.new_file(File.expand_path('.github/store-media/StoreCapture.swift'))
test.source_build_phase.add_file_reference(source)
test.build_configurations.each do |configuration|
  configuration.build_settings.merge!({
    'SWIFT_VERSION' => '5.0',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.sangminbis9.skinstudio.storecapture',
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'TEST_TARGET_NAME' => 'App'
  })
end
project.save

scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(app, test)
scheme.save_as(path, 'StoreMedia', true)

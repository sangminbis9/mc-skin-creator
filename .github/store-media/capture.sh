#!/usr/bin/env bash
set -euo pipefail

output="$RUNNER_TEMP/store-output"
mkdir -p "$output"
udid=$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; print(next((d["udid"] for group in json.load(sys.stdin)["devices"].values() for d in group if d["state"]=="Booted"), ""))')
if [[ -n "$udid" ]]; then xcrun simctl shutdown "$udid" || true; fi
udid=$(xcrun simctl list devices available -j | python3 -c '
import json, os, re, sys
pattern = r"iPhone (17|16) Pro Max" if os.environ["STORE_DEVICE"] == "iphone" else r"iPad Pro 13.inch \(M[45]\)"
devices = [d for group in json.load(sys.stdin)["devices"].values() for d in group if re.fullmatch(pattern, d["name"])]
if not devices: raise SystemExit("No matching simulator")
print(devices[0]["udid"])
')
xcrun simctl boot "$udid" || true
xcrun simctl bootstatus "$udid" -b
xcrun simctl status_bar "$udid" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState discharging --batteryLevel 100
xcrun simctl spawn "$udid" defaults write NSGlobalDomain AppleLanguages -array ko-KR ko en
xcrun simctl spawn "$udid" defaults write NSGlobalDomain AppleLocale -string ko_KR

project=app-store/ios/App/App.xcodeproj
derived="$RUNNER_TEMP/store-build"
result="$RUNNER_TEMP/store.xcresult"
args=(-project "$project" -scheme StoreMedia -configuration Debug -destination "id=$udid" -derivedDataPath "$derived" -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO)
xcodebuild "${args[@]}" build-for-testing > "$output/build.log" 2>&1 || { tail -150 "$output/build.log"; exit 1; }

rm -f /tmp/skin-store-recording
xcrun simctl io "$udid" recordVideo --codec=h264 "$output/raw.mov" &
recorder=$!
xcodebuild "${args[@]}" -resultBundlePath "$result" test-without-building > "$output/capture.log" 2>&1 &
tester=$!
started=$SECONDS
until [[ -e /tmp/skin-store-recording ]] || ! kill -0 "$tester" 2>/dev/null; do sleep 0.25; done
if [[ -e /tmp/skin-store-recording ]]; then echo "$((SECONDS - started))" > "$output/action-start.txt"; fi
set +e
wait "$tester"
status=$?
kill -INT "$recorder" 2>/dev/null
wait "$recorder"
set -e
xcrun xcresulttool export attachments --path "$result" --output-path "$output/attachments" || true
tail -75 "$output/capture.log"
exit "$status"

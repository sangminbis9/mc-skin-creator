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
echo 'Simulator app and UI tests built.'
app="$derived/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl install "$udid" "$app"
xcrun simctl launch "$udid" com.sangminbis9.skinstudio -AppleLanguages '(ko)' -AppleLocale ko_KR
sleep 3
xcrun simctl io "$udid" screenshot "$output/landing.png"

rm -f /tmp/skin-store-recording
set +e
python3 - "$udid" "$output" xcodebuild "${args[@]}" -resultBundlePath "$result" test-without-building <<'PY'
import pathlib, signal, subprocess, sys, time

device, output, *command = sys.argv[1:]
output = pathlib.Path(output)
video = subprocess.Popen(['xcrun', 'simctl', 'io', device, 'recordVideo', '--codec=h264', '--mask=ignored', str(output/'raw.mov')], start_new_session=True)
started = time.monotonic()
try:
    with (output/'capture.log').open('w') as log:
        test = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        while test.poll() is None and time.monotonic() - started < 210:
            timing = output/'action-start.txt'
            if pathlib.Path('/tmp/skin-store-recording').exists() and not timing.exists():
                timing.write_text(str(time.monotonic() - started))
            time.sleep(0.25)
        if test.poll() is None:
            test.terminate()
            test.wait(timeout=20)
finally:
    if video.poll() is None:
        video.send_signal(signal.SIGINT)
        try:
            video.wait(timeout=20)
        except subprocess.TimeoutExpired:
            video.terminate()
            video.wait(timeout=10)
sys.exit(test.returncode)
PY
status=$?
set -e
xcrun xcresulttool export attachments --path "$result" --output-path "$output/attachments" || true
tail -75 "$output/capture.log"
exit "$status"

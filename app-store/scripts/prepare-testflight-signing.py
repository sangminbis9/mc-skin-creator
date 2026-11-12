"""Validate the installed distribution identity and prepare Xcode export settings."""

import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def main(signing_dir: Path, keychain: str) -> None:
    app_root = Path(__file__).resolve().parent.parent
    bundle_id = json.loads((app_root / "store.config.json").read_text(encoding="utf-8"))["bundleId"]
    profile = plistlib.loads((signing_dir / "profile.plist").read_bytes())
    entitlements = profile["Entitlements"]
    team_id = entitlements["com.apple.developer.team-identifier"]
    profile_uuid = profile["UUID"]

    if not re.fullmatch(r"[A-Z0-9]{10}", team_id) or team_id not in profile["TeamIdentifier"]:
        sys.exit("The provisioning profile has an invalid Apple Team ID.")
    if not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", profile_uuid):
        sys.exit("The provisioning profile has an invalid UUID.")
    if entitlements["application-identifier"].partition(".")[2] != bundle_id:
        sys.exit(f"The provisioning profile must use the explicit App ID {bundle_id}.")
    if profile["ExpirationDate"].replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        sys.exit("The App Store Connect provisioning profile has expired.")
    if (
        "iOS" not in profile.get("Platform", [])
        or entitlements.get("get-task-allow") is not False
        or "ProvisionedDevices" in profile
        or profile.get("ProvisionsAllDevices")
    ):
        sys.exit("Use an iOS App Store Connect distribution profile.")

    identities = subprocess.check_output(
        ["security", "find-identity", "-v", "-p", "codesigning", keychain], text=True
    )
    distribution_identities = set(re.findall(r'\b([A-F0-9]{40})\s+"Apple Distribution:', identities))
    profile_certificates = {hashlib.sha1(cert).hexdigest().upper() for cert in profile["DeveloperCertificates"]}
    matching_identities = distribution_identities & profile_certificates
    if len(matching_identities) != 1:
        sys.exit("The .p12 must contain a valid Apple Distribution identity selected in the provisioning profile.")
    identity = matching_identities.pop()

    export_options = {
        "method": "app-store-connect",
        "destination": "upload",
        "signingStyle": "manual",
        "signingCertificate": identity,
        "teamID": team_id,
        "provisioningProfiles": {bundle_id: profile_uuid},
        "manageAppVersionAndBuildNumber": False,
        "testFlightInternalTestingOnly": False,
    }
    (signing_dir / "ExportOptions.plist").write_bytes(plistlib.dumps(export_options))
    with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as env:
        env.write(f"APP_STORE_TEAM_ID={team_id}\n")
        env.write(f"APP_STORE_PROFILE_UUID={profile_uuid}\n")
    print(profile_uuid)


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2])

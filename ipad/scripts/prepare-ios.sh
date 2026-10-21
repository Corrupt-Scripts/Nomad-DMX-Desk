#!/bin/bash
# Runs in CI after `cap add ios` + `cap sync ios`: permissions text, icon, version.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=ios/App/App
PLIST=$APP/Info.plist
VERSION=$(node -p "require('./package.json').version")
BUILD=${GITHUB_RUN_NUMBER:-1}

pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" 2>/dev/null || true; }
pb "Delete :NSBluetoothAlwaysUsageDescription"
pb "Add :NSBluetoothAlwaysUsageDescription string Nomad DMX Desk uses Bluetooth to send DMX to wireless lighting receivers."
pb "Delete :NSBluetoothPeripheralUsageDescription"
pb "Add :NSBluetoothPeripheralUsageDescription string Nomad DMX Desk uses Bluetooth to send DMX to wireless lighting receivers."
pb "Delete :NSLocalNetworkUsageDescription"
pb "Add :NSLocalNetworkUsageDescription string Nomad DMX Desk talks to lighting nodes on your local network (Art-Net and sACN)."
pb "Delete :UIFileSharingEnabled"
pb "Add :UIFileSharingEnabled bool true"
pb "Delete :LSSupportsOpeningDocumentsInPlace"
pb "Add :LSSupportsOpeningDocumentsInPlace bool true"
pb "Delete :UIViewControllerBasedStatusBarAppearance"
pb "Add :UIViewControllerBasedStatusBarAppearance bool true"

ICONSET=$APP/Assets.xcassets/AppIcon.appiconset
if [ -d "$ICONSET" ]; then
  cp icon-1024.png "$ICONSET/AppIcon-512@2x.png"
fi

PBX=ios/App/App.xcodeproj/project.pbxproj
sed -i '' -E "s/MARKETING_VERSION = [0-9.]+;/MARKETING_VERSION = $VERSION;/g; s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = $BUILD;/g" "$PBX"
echo "Prepared Info.plist, icon, version $VERSION ($BUILD)"
/usr/libexec/PlistBuddy -c "Print" "$PLIST" | head -60

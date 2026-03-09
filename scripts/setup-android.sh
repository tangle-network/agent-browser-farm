#!/bin/bash
set -euo pipefail

# Setup script for Android emulator-based Chrome sessions.
#
# What this does:
#   1. Verifies Android SDK is installed
#   2. Downloads system image for the target API level
#   3. Creates an AVD with Chrome pre-installed
#   4. Boots it once to create a quickboot snapshot
#   5. Prints the registration command
#
# Prerequisites:
#   - Android SDK (ANDROID_HOME set)
#   - Java 17+ (for sdkmanager)
#
# Usage:
#   ANDROID_HOME=/path/to/sdk ./scripts/setup-android.sh

API_LEVEL="${API_LEVEL:-34}"
AVD_NAME="${AVD_NAME:-chrome-farm}"
DEVICE_TYPE="${DEVICE_TYPE:-pixel_6}"

echo "=== agent-browser-farm: Android emulator setup ==="
echo ""
echo "Config:"
echo "  API_LEVEL:   ${API_LEVEL}"
echo "  AVD_NAME:    ${AVD_NAME}"
echo "  DEVICE_TYPE: ${DEVICE_TYPE}"
echo ""

# Check ANDROID_HOME
if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -z "${ANDROID_SDK_ROOT:-}" ]]; then
    echo "ERROR: ANDROID_HOME or ANDROID_SDK_ROOT must be set."
    echo "  macOS: export ANDROID_HOME=~/Library/Android/sdk"
    echo "  Linux: export ANDROID_HOME=/usr/local/android-sdk"
    exit 1
  fi
  ANDROID_HOME="${ANDROID_SDK_ROOT}"
fi

echo "✓ ANDROID_HOME=${ANDROID_HOME}"

# Detect architecture
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
  SYS_IMAGE_ARCH="arm64-v8a"
  echo "✓ ARM64 detected — using ARM system images (native speed on Apple Silicon)"
else
  SYS_IMAGE_ARCH="x86_64"
  echo "✓ x86_64 detected — using x86_64 system images"
fi

SDKMANAGER="${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="${ANDROID_HOME}/cmdline-tools/latest/bin/avdmanager"
ADB="${ANDROID_HOME}/platform-tools/adb"
EMULATOR="${ANDROID_HOME}/emulator/emulator"

# Install system image
SYS_IMAGE="system-images;android-${API_LEVEL};google_apis;${SYS_IMAGE_ARCH}"
echo ""
echo "Installing system image: ${SYS_IMAGE}..."
echo "y" | ${SDKMANAGER} "${SYS_IMAGE}" "platform-tools" "emulator" 2>/dev/null || true

# Create AVD
echo ""
echo "Creating AVD: ${AVD_NAME}..."
echo "no" | ${AVDMANAGER} create avd \
  -n "${AVD_NAME}" \
  -k "${SYS_IMAGE}" \
  -d "${DEVICE_TYPE}" \
  --force

echo "✓ AVD created: ${AVD_NAME}"

# Boot once to create quickboot snapshot
echo ""
echo "Booting emulator to create snapshot (this takes 30-60s)..."
${EMULATOR} @${AVD_NAME} -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect &
EMU_PID=$!

# Wait for boot
${ADB} wait-for-device
echo "  Waiting for boot_completed..."
while [[ "$(${ADB} shell getprop sys.boot_completed 2>/dev/null)" != "1" ]]; do
  sleep 2
done

echo "✓ Emulator booted"

# Dismiss Chrome first-run dialog
echo "  Configuring Chrome..."
${ADB} shell "pm grant com.android.chrome android.permission.POST_NOTIFICATIONS" 2>/dev/null || true
${ADB} shell "am start -n com.android.chrome/com.google.android.apps.chrome.Main -d about:blank" 2>/dev/null || true
sleep 3
# Accept Chrome ToS by sending key events
${ADB} shell "input keyevent KEYCODE_TAB && input keyevent KEYCODE_TAB && input keyevent KEYCODE_ENTER" 2>/dev/null || true
sleep 2

# Verify CDP works
echo "  Verifying CDP access..."
${ADB} forward tcp:9222 localabstract:chrome_devtools_remote
CDP_CHECK=$(curl -s http://127.0.0.1:9222/json/version 2>/dev/null || echo "FAIL")
if echo "$CDP_CHECK" | grep -q "webSocketDebuggerUrl"; then
  echo "✓ CDP endpoint verified"
else
  echo "⚠ CDP check failed — Chrome may need manual first-run setup"
fi
${ADB} forward --remove tcp:9222 2>/dev/null || true

# Kill emulator (saves quickboot snapshot automatically)
echo ""
echo "Shutting down emulator (saving snapshot)..."
${ADB} emu kill 2>/dev/null || kill $EMU_PID 2>/dev/null || true
wait $EMU_PID 2>/dev/null || true

echo "✓ Snapshot saved"

echo ""
echo "=== Setup complete ==="
echo ""
echo "AVD '${AVD_NAME}' is ready with Chrome + quickboot snapshot."
echo ""
echo "To register with your farm:"
echo ""
echo "  curl -X POST http://YOUR_FARM:9222/backends \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -H 'Authorization: Bearer YOUR_API_TOKEN' \\"
echo "    -d '{\"type\": \"android\", \"avdName\": \"${AVD_NAME}\", \"capacity\": 4}'"
echo ""
echo "Or programmatically:"
echo ""
echo "  import { createApp, AndroidBackend } from 'agent-browser-farm';"
echo "  const app = createApp({ backends: ["
echo "    new AndroidBackend({ avdName: '${AVD_NAME}', capacity: 4 })"
echo "  ]});"
echo ""
echo "Then clients request Android Chrome sessions:"
echo ""
echo "  POST /sessions { \"browser\": \"android-chrome\" }"
echo "  // Returns wsEndpoint — same CDP protocol as desktop Chrome"
echo ""

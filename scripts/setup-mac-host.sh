#!/bin/bash
set -euo pipefail

# Setup script for macOS hosts providing iOS Safari simulator sessions.
#
# What this does:
#   1. Verifies Xcode CLI tools are installed
#   2. Installs Appium 3 + XCUITest driver
#   3. Creates a template iOS simulator
#   4. Pre-installs WebDriverAgent on the template (speeds up session creation)
#   5. Optionally installs Playwright WebKit for emulated Safari sessions
#   6. Prints registration commands
#
# Prerequisites:
#   - macOS with Xcode installed (full Xcode, not just CLI tools)
#   - Node.js 18+
#
# Usage:
#   ./scripts/setup-mac-host.sh
#   # or with custom iOS version:
#   IOS_VERSION=17.2 DEVICE_TYPE="iPhone 15" ./scripts/setup-mac-host.sh

IOS_VERSION="${IOS_VERSION:-17.2}"
DEVICE_TYPE="${DEVICE_TYPE:-iPhone 15}"
IPAD_DEVICE_TYPE="${IPAD_DEVICE_TYPE:-iPad Pro (11-inch) (4th generation)}"
TEMPLATE_NAME="${TEMPLATE_NAME:-farm-template}"
IPAD_TEMPLATE_NAME="${IPAD_TEMPLATE_NAME:-farm-ipad-template}"
SETUP_IPAD="${SETUP_IPAD:-true}"

echo "=== agent-browser-farm: macOS host setup (iOS Safari) ==="
echo ""
echo "Config:"
echo "  IOS_VERSION:         ${IOS_VERSION}"
echo "  DEVICE_TYPE:         ${DEVICE_TYPE}"
echo "  IPAD_DEVICE_TYPE:    ${IPAD_DEVICE_TYPE}"
echo "  TEMPLATE_NAME:       ${TEMPLATE_NAME}"
echo "  IPAD_TEMPLATE_NAME:  ${IPAD_TEMPLATE_NAME}"
echo "  SETUP_IPAD:          ${SETUP_IPAD}"
echo ""

# Check macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: This script is for macOS only."
  exit 1
fi

# Check Xcode
if ! xcode-select -p &>/dev/null; then
  echo "ERROR: Xcode CLI tools required. Run: xcode-select --install"
  exit 1
fi
echo "✓ Xcode: $(xcode-select -p)"

# Check xcrun simctl
if ! xcrun simctl help &>/dev/null; then
  echo "ERROR: xcrun simctl not available. Full Xcode installation required."
  exit 1
fi
echo "✓ xcrun simctl available"

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js 18+ required."
  exit 1
fi
echo "✓ Node.js $(node -v)"

# Install Appium
echo ""
echo "Installing Appium 3 + XCUITest driver..."
if ! command -v appium &>/dev/null; then
  npm install -g appium@latest
fi
echo "✓ Appium $(appium --version)"

# Install XCUITest driver
appium driver install xcuitest 2>/dev/null || appium driver update xcuitest 2>/dev/null || true
echo "✓ XCUITest driver installed"

# Find iOS runtime
echo ""
echo "Looking for iOS ${IOS_VERSION} runtime..."
RUNTIME=$(xcrun simctl list runtimes -j | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const rt = data.runtimes.find(r => r.name.includes('iOS') && r.version.startsWith('${IOS_VERSION}'));
  if (rt) console.log(rt.identifier);
  else { console.error('iOS ${IOS_VERSION} runtime not found. Available:');
    data.runtimes.filter(r=>r.name.includes('iOS')).forEach(r=>console.error('  '+r.name+' ('+r.identifier+')'));
    process.exit(1);
  }
")
echo "✓ Runtime: ${RUNTIME}"

# Create template simulator
echo ""
echo "Creating template simulator: ${TEMPLATE_NAME}..."
# Delete existing template if present
xcrun simctl delete "${TEMPLATE_NAME}" 2>/dev/null || true
TEMPLATE_UDID=$(xcrun simctl create "${TEMPLATE_NAME}" "${DEVICE_TYPE}" "${RUNTIME}")
echo "✓ Template UDID: ${TEMPLATE_UDID}"

# Boot template to initialize it
echo ""
echo "Booting template simulator for first-time setup..."
xcrun simctl boot "${TEMPLATE_UDID}"

# Wait for boot
echo "  Waiting for boot..."
while true; do
  STATE=$(xcrun simctl list devices -j | node -e "
    const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    for (const [rt, devs] of Object.entries(data.devices)) {
      const d = devs.find(d => d.udid === '${TEMPLATE_UDID}');
      if (d) { console.log(d.state); break; }
    }
  ")
  if [[ "$STATE" == "Booted" ]]; then break; fi
  sleep 2
done
echo "✓ Template booted"

# Open Safari once to accept any first-run dialogs
echo "  Launching Safari..."
xcrun simctl openurl "${TEMPLATE_UDID}" "https://example.com" 2>/dev/null || true
sleep 5

# Pre-build and install WDA (speeds up future Appium sessions from ~30s to ~3s)
echo ""
echo "Pre-installing WebDriverAgent (this takes 1-3 minutes on first run)..."
echo "  Starting Appium temporarily..."

# Start Appium in background
appium --port 4723 --log-level error &
APPIUM_PID=$!
sleep 3

# Create a quick session to trigger WDA build
WDA_RESULT=$(curl -s -X POST http://localhost:4723/session \
  -H 'Content-Type: application/json' \
  -d "{
    \"capabilities\": {
      \"alwaysMatch\": {
        \"platformName\": \"iOS\",
        \"appium:automationName\": \"XCUITest\",
        \"browserName\": \"Safari\",
        \"appium:udid\": \"${TEMPLATE_UDID}\",
        \"appium:deviceName\": \"${DEVICE_TYPE}\",
        \"appium:noReset\": true
      }
    }
  }" 2>/dev/null || echo '{"error":"failed"}')

# Extract session ID and delete
WDA_SESSION=$(echo "$WDA_RESULT" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  if (d.value && d.value.sessionId) console.log(d.value.sessionId);
  else console.log('FAIL');
")

if [[ "$WDA_SESSION" != "FAIL" ]]; then
  curl -s -X DELETE "http://localhost:4723/session/${WDA_SESSION}" >/dev/null 2>&1 || true
  echo "✓ WebDriverAgent pre-installed"
else
  echo "⚠ WDA pre-install failed — Appium will build it on first real session (slower)"
fi

# Kill Appium
kill $APPIUM_PID 2>/dev/null || true
wait $APPIUM_PID 2>/dev/null || true

# Shutdown template (keep it around for cloning)
echo ""
echo "Shutting down template simulator..."
xcrun simctl shutdown "${TEMPLATE_UDID}" 2>/dev/null || true
echo "✓ Template ready for cloning"

# --- iPad Template ---
IPAD_TEMPLATE_UDID=""
if [[ "${SETUP_IPAD}" == "true" ]]; then
  echo ""
  echo "Creating iPad template simulator: ${IPAD_TEMPLATE_NAME}..."
  xcrun simctl delete "${IPAD_TEMPLATE_NAME}" 2>/dev/null || true
  IPAD_TEMPLATE_UDID=$(xcrun simctl create "${IPAD_TEMPLATE_NAME}" "${IPAD_DEVICE_TYPE}" "${RUNTIME}")
  echo "✓ iPad Template UDID: ${IPAD_TEMPLATE_UDID}"

  echo ""
  echo "Booting iPad template simulator..."
  xcrun simctl boot "${IPAD_TEMPLATE_UDID}"

  echo "  Waiting for boot..."
  while true; do
    STATE=$(xcrun simctl list devices -j | node -e "
      const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      for (const [rt, devs] of Object.entries(data.devices)) {
        const d = devs.find(d => d.udid === '${IPAD_TEMPLATE_UDID}');
        if (d) { console.log(d.state); break; }
      }
    ")
    if [[ "$STATE" == "Booted" ]]; then break; fi
    sleep 2
  done
  echo "✓ iPad template booted"

  echo "  Launching Safari..."
  xcrun simctl openurl "${IPAD_TEMPLATE_UDID}" "https://example.com" 2>/dev/null || true
  sleep 5

  # Pre-build WDA on iPad template too
  echo ""
  echo "Pre-installing WebDriverAgent on iPad template..."
  appium --port 4724 --log-level error &
  IPAD_APPIUM_PID=$!
  sleep 3

  IPAD_WDA_RESULT=$(curl -s -X POST http://localhost:4724/session \
    -H 'Content-Type: application/json' \
    -d "{
      \"capabilities\": {
        \"alwaysMatch\": {
          \"platformName\": \"iOS\",
          \"appium:automationName\": \"XCUITest\",
          \"browserName\": \"Safari\",
          \"appium:udid\": \"${IPAD_TEMPLATE_UDID}\",
          \"appium:deviceName\": \"${IPAD_DEVICE_TYPE}\",
          \"appium:noReset\": true
        }
      }
    }" 2>/dev/null || echo '{"error":"failed"}')

  IPAD_WDA_SESSION=$(echo "$IPAD_WDA_RESULT" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (d.value && d.value.sessionId) console.log(d.value.sessionId);
    else console.log('FAIL');
  ")

  if [[ "$IPAD_WDA_SESSION" != "FAIL" ]]; then
    curl -s -X DELETE "http://localhost:4724/session/${IPAD_WDA_SESSION}" >/dev/null 2>&1 || true
    echo "✓ WebDriverAgent pre-installed on iPad"
  else
    echo "⚠ iPad WDA pre-install failed — will build on first session"
  fi

  kill $IPAD_APPIUM_PID 2>/dev/null || true
  wait $IPAD_APPIUM_PID 2>/dev/null || true

  xcrun simctl shutdown "${IPAD_TEMPLATE_UDID}" 2>/dev/null || true
  echo "✓ iPad template ready for cloning"
fi

# Optionally install Playwright WebKit
echo ""
echo "Installing Playwright WebKit (for emulated Safari sessions)..."
if command -v pnpm &>/dev/null; then
  pnpm add playwright-core 2>/dev/null && pnpm exec playwright install webkit 2>/dev/null || true
elif command -v npm &>/dev/null; then
  npm install playwright-core 2>/dev/null && npx playwright install webkit 2>/dev/null || true
fi
echo "✓ Playwright WebKit installed"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Templates:"
echo "  iPhone: ${TEMPLATE_NAME} (${TEMPLATE_UDID})"
if [[ -n "${IPAD_TEMPLATE_UDID}" ]]; then
  echo "  iPad:   ${IPAD_TEMPLATE_NAME} (${IPAD_TEMPLATE_UDID})"
fi
echo ""
echo "Mac can run 8-10 concurrent simulators (16GB RAM) or 12-14 (24GB RAM)."
echo ""
echo "To start Appium on this host:"
echo ""
echo "  appium --port 4723 --use-drivers xcuitest"
echo ""
echo "To register this Mac with your farm:"
echo ""
if [[ -n "${IPAD_TEMPLATE_UDID}" ]]; then
  echo "  # Real iOS Safari with iPhone + iPad templates"
  echo "  curl -X POST http://YOUR_FARM:9222/backends \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{"
  echo "      \"type\": \"ios-safari\","
  echo "      \"url\": \"http://$(hostname):4723\","
  echo "      \"templates\": { \"iPhone\": \"${TEMPLATE_UDID}\", \"iPad\": \"${IPAD_TEMPLATE_UDID}\" },"
  echo "      \"capacity\": 8"
  echo "    }'"
else
  echo "  # Real iOS Safari (iPhone only)"
  echo "  curl -X POST http://YOUR_FARM:9222/backends \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"type\": \"ios-safari\", \"url\": \"http://$(hostname):4723\", \"templateUdid\": \"${TEMPLATE_UDID}\", \"capacity\": 8}'"
fi
echo ""
echo "  # Emulated Safari (Playwright WebKit — same WS proxy, faster)"
echo "  curl -X POST http://YOUR_FARM:9222/backends \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"type\": \"playwright\", \"id\": \"mac-$(hostname -s)\"}'"
echo ""
echo "Client usage:"
echo ""
echo "  # Real iPhone Safari"
echo "  POST /sessions { \"browser\": \"ios-safari\", \"device\": \"iPhone 15\" }"
echo ""
echo "  # Real iPad Safari"
echo "  POST /sessions { \"browser\": \"ios-safari\", \"device\": \"iPad Pro 11\" }"
echo ""
echo "  # Both return webdriverUrl + webdriverSessionId — use with Selenium/WebDriver"
echo ""
echo "  # Emulated Safari (Playwright WebKit)"
echo "  POST /sessions { \"browser\": \"webkit\" }"
echo "  // Returns wsEndpoint — use with playwright.webkit.connect()"
echo ""

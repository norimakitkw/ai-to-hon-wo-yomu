#!/bin/zsh
# 研究用サーバーを、ログイン中ずっと動かす（止まったら立ち上げ直す・スリープしない）
set -eu
cd "$(dirname "$0")"
LABEL=jp.mwmw.ai-to-hon-wo-yomu
NODE=$(command -v node)
PLIST=~/Library/LaunchAgents/$LABEL.plist
LOG=~/Library/Logs/ai-to-hon-wo-yomu.log
[ -f ~/.config/ai-to-hon-wo-yomu/anthropic-key ] || { echo "先にキーを置いてください（README の 1）"; exit 1; }
[ -d node_modules ] || npm ci
mkdir -p ~/Library/LaunchAgents
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>$NODE</string><string>$PWD/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
sleep 2
curl -fsS http://127.0.0.1:8790/health && echo && echo "動いています（ログ：$LOG）"

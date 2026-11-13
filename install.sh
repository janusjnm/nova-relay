#!/usr/bin/env bash
# install.sh — install nova-relay from this checkout. Safe and idempotent:
#   * copies files only from this local checkout (never downloads or pipes remote code)
#   * installs each version side by side and switches a `current` symlink atomically, so
#     running workers keep using the version they started with
#   * never deletes anything and never overwrites an existing config or secrets file
#
# usage: ./install.sh [--systemd box|vps]
set -euo pipefail

ROLE=""
if [ "${1:-}" = "--systemd" ]; then ROLE="${2:-}"; fi
case "$ROLE" in ""|box|vps) ;; *) echo "usage: ./install.sh [--systemd box|vps]" >&2; exit 2 ;; esac

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${NOVA_RELAY_PREFIX:-$HOME/.local/share/nova-relay}"
BIN_DIR="${NOVA_RELAY_BIN_DIR:-$HOME/.local/bin}"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/nova-relay"

echo "==> checking prerequisites"
command -v node >/dev/null 2>&1 || { echo "error: node not found (need Node.js >= 22)" >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || { echo "error: Node.js $(node -v) found, need >= 22" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "error: git not found (need >= 2.38)" >&2; exit 1; }
GIT_VER=$(git --version | awk '{print $3}')
if [ "$(printf '%s\n2.38\n' "$GIT_VER" | sort -V | head -1)" != "2.38" ]; then
  echo "error: git $GIT_VER found, need >= 2.38 (merge-tree --write-tree)" >&2; exit 1
fi
echo "  ok node $(node -v), git $GIT_VER"

VERSION=$(node -p "require('$SRC/package.json').version")
DEST="$PREFIX/versions/$VERSION"
echo "==> installing nova-relay $VERSION to $DEST"
mkdir -p "$DEST" "$BIN_DIR" "$CONF_DIR"
for d in bin lib extensions systemd config templates routines skills; do
  [ -d "$SRC/$d" ] && cp -R "$SRC/$d" "$DEST/"
done
cp "$SRC/package.json" "$SRC/LICENSE" "$SRC/NOTICE" "$DEST/"
chmod +x "$DEST/bin/nova-relay" "$DEST/bin/nova-relay.mjs" "$DEST/bin/nova-guard-hook.mjs"

# Atomic switch: new symlink next to the old one, then rename over it.
ln -sfn "$DEST" "$PREFIX/current.tmp.$$"
mv -T "$PREFIX/current.tmp.$$" "$PREFIX/current"
ln -sfn "$PREFIX/current/bin/nova-relay" "$BIN_DIR/nova-relay"
echo "  ok $BIN_DIR/nova-relay -> $PREFIX/current/bin/nova-relay"

if [ ! -e "$CONF_DIR/config.json" ]; then
  install -m 600 "$SRC/config/nova-relay.example.json" "$CONF_DIR/config.json"
  echo "  ok created $CONF_DIR/config.json from the example — edit it (self, hosts, projects)"
else
  echo "  ok kept existing $CONF_DIR/config.json"
fi
if [ ! -e "$CONF_DIR/secrets.env" ]; then
  install -m 600 /dev/null "$CONF_DIR/secrets.env"
  echo "  ok created empty $CONF_DIR/secrets.env (0600) — put KEY=VALUE secrets here, never in the repo"
fi

if [ -n "$ROLE" ]; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  if [ "$ROLE" = box ]; then UNITS="nova-relay-tick.service nova-relay-tick.timer"; TIMER=nova-relay-tick.timer
  else UNITS="nova-relay-watchdog.service nova-relay-watchdog.timer"; TIMER=nova-relay-watchdog.timer; fi
  for u in $UNITS; do cp "$SRC/systemd/$u" "$UNIT_DIR/$u"; done
  echo "  ok installed $UNITS to $UNIT_DIR"
  echo "     enable with: systemctl --user daemon-reload && systemctl --user enable --now $TIMER"
  echo "     (and: loginctl enable-linger \$USER so it runs without a login session)"
fi

echo ""
echo "next:"
echo "  1. edit $CONF_DIR/config.json  (docs/config.md)"
echo "  2. nova-relay doctor"
echo "  3. see README.zh-CN.md / docs/setup-box.md / docs/setup-vps.md"

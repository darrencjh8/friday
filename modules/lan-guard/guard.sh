#!/bin/sh
# Lets only LAPTOP_LAN_HOST reach GUARDED_PORTS on SERVER_LAN_HOST, through
# Docker's DOCKER-USER chain. It matches the connection's original destination
# address, so container-to-container traffic and the 127.0.0.1 bindings are
# never touched. Re-running replaces the rules instead of adding copies.
set -eu

: "${SERVER_LAN_HOST:?}" "${LAPTOP_LAN_HOST:?}" "${GUARDED_PORTS:?}"
IPTABLES="${IPTABLES:-}"

if [ -z "$IPTABLES" ]; then
  # ponytail: installs iptables at every start (needs the Alpine mirror); bake
  # an image if the server ever has to boot without internet.
  apk add --no-cache iptables iptables-legacy >/dev/null
  # Use whichever backend Docker's own chain lives in.
  if iptables-nft -S DOCKER-USER >/dev/null 2>&1; then
    IPTABLES=iptables-nft
  elif iptables-legacy -S DOCKER-USER >/dev/null 2>&1; then
    IPTABLES=iptables-legacy
  else
    echo "lan-guard: DOCKER-USER chain not found" >&2
    exit 1
  fi
fi

COMMENT="friday-lan-guard"

# Remove this script's earlier rules, newest first, before adding them again.
$IPTABLES -S DOCKER-USER | grep -- "--comment $COMMENT" | sed 's/^-A /-D /' | while read -r rule; do
  # shellcheck disable=SC2086  # the rule is a list of iptables arguments
  $IPTABLES $rule
done

for port in $GUARDED_PORTS; do
  $IPTABLES -I DOCKER-USER -p tcp -m conntrack --ctorigdst "$SERVER_LAN_HOST" \
    --ctorigdstport "$port" --ctdir ORIGINAL ! -s "$LAPTOP_LAN_HOST" \
    -m comment --comment "$COMMENT" -j DROP
done

echo "lan-guard: $GUARDED_PORTS on $SERVER_LAN_HOST open to $LAPTOP_LAN_HOST only ($IPTABLES)"
[ "${LAN_GUARD_ONCE:-}" = 1 ] && exit 0
exec sleep infinity

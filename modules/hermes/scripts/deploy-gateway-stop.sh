# Sourced by modules/deploy.sh. Stops the hermes gateways before the container
# goes away, because a container stop can reach them only at Docker's kill limit
# (#107). Both functions tolerate a missing container: a first deploy has none.

stop_hermes_gateways() {
  # In parallel, so the deploy waits 45 s at most. A gateway still busy after that
  # is left to the container stop, which is what happened before this existed.
  docker exec hermes sh -c '
    for s in /run/service/gateway-*; do
      (
        if /package/admin/s6/command/s6-svc -wD -T 45000 -d "$s"; then
          echo "  $s stopped"
        else
          echo "  $s still running after 45 s"
        fi
      ) &
    done
    wait
  ' 2>/dev/null || true
}

# Compose keeps a container whose image and config did not change, and nothing
# else would restart its gateways. On a new container this changes nothing.
start_hermes_gateways() {
  docker exec hermes sh -c '
    for s in /run/service/gateway-*; do
      /package/admin/s6/command/s6-svc -u "$s"
    done
  ' 2>/dev/null || true
}

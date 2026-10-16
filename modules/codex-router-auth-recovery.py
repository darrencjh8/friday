"""Run one Router-owned ChatGPT device login from inside its container."""

import asyncio
import sys


async def recover(account, manager, sleep=asyncio.sleep, output=print):
    """Authorize one account without printing or copying token material."""
    started = await manager.start(account)
    output(f"Open {started['verification_url']}")
    output(f"Enter code: {started['user_code']}")
    output("Waiting for browser authorization...")

    interval = max(1, int(started.get("poll_interval") or 5))
    while True:
        await sleep(interval)
        result = await manager.result(account)
        status = result.get("status")
        if status == "pending":
            continue
        if status == "expired":
            raise TimeoutError("device login expired before authorization")
        if status != "complete":
            raise RuntimeError(f"device login returned unexpected status: {status!r}")
        if result.get("available") is not True:
            raise RuntimeError(f"{account} was authorized but did not become available")
        output(f"{account} is available")
        return


def main():
    """Load the deployed Router manager and run the requested account login."""
    if len(sys.argv) != 2:
        raise SystemExit("usage: codex-router-auth-recovery.py acct1|acct2|acct3")
    sys.path.insert(0, "/app")
    from router.mcp_server import manager

    asyncio.run(recover(sys.argv[1], manager, output=lambda message: print(message, flush=True)))


if __name__ == "__main__":
    main()

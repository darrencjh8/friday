#!/usr/bin/env python3
"""`google login | status | logout`: the one Google login for Friday's CLIs.

One consent grants tasks (gtasks: read and write), gmail.readonly (gmail) and
calendar.readonly (gcal). Login refuses a token that grants anything more, so
no CLI can send, delete, or edit mail or events whoever holds the token.
The OAuth flow itself lives in gtasks.py.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gtasks  # noqa: E402  (OAuth helpers; same directory)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="google", description="Friday's Google login.")
    sub = parser.add_subparsers(dest="command", required=True)
    login = sub.add_parser("login")
    login.add_argument("--redirect-uri", default="")
    login.add_argument("--port", type=int, default=gtasks.CALLBACK_PORT)
    login.add_argument("--timeout", type=int, default=gtasks.LOGIN_TIMEOUT)
    login.add_argument("--manual", action="store_true",
                       help="paste the redirect URL by hand instead of receiving the callback")
    sub.add_parser("status")
    sub.add_parser("logout")
    args = parser.parse_args(argv)
    if args.command == "login":
        gtasks.cmd_login(args)
    elif args.command == "status":
        granted = gtasks.granted_scopes()
        print("logged in: " + ", ".join(sorted(s.rsplit("/", 1)[-1] for s in granted))
              if granted else "not logged in")
    elif args.command == "logout":
        try:
            os.remove(gtasks._token_path())
        except OSError:
            pass
        print("Local token deleted. Revoke access at Google account > Security > Third-party access.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

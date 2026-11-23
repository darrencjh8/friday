---
name: wol
description: Use to start (wake up) the user's PC, e.g. "start my computer", "turn on my PC", "wake the desktop".
version: 1.0.0
author: Hermes Agent
license: MIT-0
metadata:
  hermes:
    tags: [wake-on-lan, wol, pc, smart-home]
---

# Wake the PC

The `wol` CLI wakes the user's PC with a wake-on-LAN magic packet sent straight to its IP on the home network.

- Wake it: `wol`. Say it was sent and that the PC takes a little while to come up; a sent packet does not prove the PC woke.
- See which PC is saved: `wol show`.

`wol` says "no PC saved yet" until the user saves one on the machine that runs Hermes with `docker exec hermes wol set <pc-ip> <pc-mac>`; point them to that command. Only home network addresses are accepted.

Wake the PC only when the user asks. There is no way to put it back to sleep or shut it down from here.

If the PC does not wake, suggest checking on the PC: the network card's "Wake on Magic Packet" and "ARP Offload" are enabled, "Allow this device to wake the computer" is ticked, and the PC is asleep (not shut down). Wake-on-LAN over Wi-Fi only works on cards and drivers that support it; a network cable is the reliable way.

# Feature Specification: Telegram Link Preview Disable

**Feature:** telegram-link-preview  
**Spec Version:** 1.0.0  
**Status:** Implemented
**Constitution Hash:** v4.0.0  

---

## Overview

Disable automatic URL link previews in outbound Telegram messages sent by the OpenClaw gateway bot. By default, the Telegram Bot API generates rich previews (title, description, image) for any URL in an outbound message. This is undesirable for a finance assistant bot — previews can be distracting, may leak metadata, and add visual noise.

OpenClaw exposes `channels.telegram.linkPreview` to control this behavior. Setting it to `false` disables automatic URL entity detection for rich text outbound messages.

---

## User Stories

### US-1: Disable Telegram Link Previews

**As a** user receiving messages from the OpenClaw bot,  
**I want** URLs in bot messages to appear as plain text without rich previews,  
**So that** messages are clean, distraction-free, and do not leak metadata to Telegram's preview generator.

**Acceptance Criteria:**
- [x] `channels.telegram.linkPreview` is set to `false` in `gateway/openclaw.json`
- [x] The config file is valid JSON (parses without errors)
- [ ] After deploy, URLs in bot outbound messages render as plain text (no thumbnail, title, or description cards) — requires production deploy

---

## Requirements

### Functional Requirements

- **FR-001**: `gateway/openclaw.json` MUST include `"linkPreview": false` within the `channels.telegram` object
- **FR-002**: The config file MUST remain valid JSON after the change
- **FR-003**: No other config values in `channels.telegram` MUST be altered

### Non-Functional Requirements

- **NFR-001**: Config change is zero-risk — no code paths depend on `linkPreview` being `true`
- **NFR-002**: Config change requires only a gateway restart (`docker compose restart openclaw`), not a rebuild

---

## Success Criteria

- **SC-001**: Config validation test passes — confirms `linkPreview: false` is present
- **SC-002**: `docker compose config` shows no parse errors
- **SC-003**: After deploy, bot outbound messages containing URLs show no link previews

---

## Non-Goals

- Disabling link previews on a per-message basis (OpenClaw supports this via message-level options; not needed)
- Changing link preview behavior for inbound messages (not applicable — bots don't receive previews)
- Any code changes outside `gateway/openclaw.json`

---

## References

- [OpenClaw Telegram Channel Docs](https://docs.openclaw.ai/channels/telegram)
- GitHub Issue: [#46](https://github.com/darrencjh8/friday/issues/46)

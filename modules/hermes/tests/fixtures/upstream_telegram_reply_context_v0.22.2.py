class TelegramAdapter:
    def __init__(self):
        self._rich_text = ""

    def _extract_rich_reply_text(self, reply_to_message):
        return self._rich_text or None

    def _reply_context(self, message):
        """Return reply context with Telegram's native partial quote first."""
        if not message.reply_to_message:
            return None, None
        reply_to_id = str(message.reply_to_message.message_id)
        quote = getattr(message, "quote", None)
        quote_text = getattr(quote, "text", None) if quote is not None else None
        if quote_text:
            return reply_to_id, quote_text
        reply_to_text = message.reply_to_message.text or message.reply_to_message.caption or None
        if not reply_to_text:
            reply_to_text = self._extract_rich_reply_text(message.reply_to_message)
        if not reply_to_text:
            try:
                from gateway import rich_sent_store
                reply_to_text = rich_sent_store.lookup(str(message.chat.id), reply_to_id)
            except Exception:
                # Extract reply context if this message is a reply. Prefer Telegram's native partial quote
                # (message.quote, TextQuote) so a user replying to a single selected substring of a prior
                # multi-section message doesn't get the whole replied-to message injected into the agent's
                # context — which can cause the agent to act on unrelated actionable-looking text the user
                # didn't quote (#22619). Fall back to the full replied-to message text / caption when no
                # native quote is present.
                reply_to_text = None
        return reply_to_id, reply_to_text

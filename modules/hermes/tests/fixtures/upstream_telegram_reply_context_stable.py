# Trimmed copy of the upstream TelegramAdapter._reply_context from the pinned
# nousresearch/hermes-agent:stable image. Helper functions are stubs.


def expand_quote_link_entities(quote, reply_to_message):
    return getattr(quote, "text", None)


def expand_link_entities(msg):
    return msg.text or msg.caption or None


def rich_message_text(msg):
    return None


class TelegramAdapter:
    def _reply_context(self, message):
        """``(reply_to_id, reply_to_text)`` for the replied-to message: Telegram's native partial quote
        first, then text/caption (hidden link URLs inlined), rich echo, then the sent index."""
        if not message.reply_to_message:
            return None, None
        reply_to_id = str(message.reply_to_message.message_id)
        quote = getattr(message, "quote", None)
        quote_text = expand_quote_link_entities(quote, message.reply_to_message) if quote is not None else None
        if quote_text:
            return reply_to_id, quote_text
        reply_to_text = expand_link_entities(message.reply_to_message) or None
        if not reply_to_text:
            reply_to_text = rich_message_text(message.reply_to_message) or None
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

_MAX_TEXT_CHARS = 2000


def record(text):
    return text[:_MAX_TEXT_CHARS]


def lookup(stored_text):
    return stored_text or None

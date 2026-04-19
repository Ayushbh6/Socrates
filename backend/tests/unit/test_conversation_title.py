from backend.src.services.projects import (
    NEW_CONVERSATION_PLACEHOLDER_TITLE,
    derive_initial_conversation_title,
)


def test_derive_title_short_first_word():
    assert derive_initial_conversation_title("Hello there") == "Hello"


def test_derive_title_long_first_word():
    assert derive_initial_conversation_title("Absolutely yes") == "Absol..."


def test_derive_title_strips_whitespace():
    assert derive_initial_conversation_title("  Hi  ") == "Hi"


def test_derive_title_empty_input_uses_placeholder():
    assert derive_initial_conversation_title("   ") == NEW_CONVERSATION_PLACEHOLDER_TITLE


def test_placeholder_constant():
    assert NEW_CONVERSATION_PLACEHOLDER_TITLE == "New conversation"

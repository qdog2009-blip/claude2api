"""Tests for AES-128-ECB crypto."""

import pytest
from wechatbot.crypto import (
    decrypt_aes_ecb,
    decode_aes_key,
    encrypt_aes_ecb,
    encrypted_size,
    encode_aes_key_base64,
    encode_aes_key_hex,
    generate_aes_key,
)
from wechatbot.errors import MediaError


def test_round_trip():
    key = generate_aes_key()
    plaintext = b"Hello, WeChat!"
    ciphertext = encrypt_aes_ecb(plaintext, key)
    decrypted = decrypt_aes_ecb(ciphertext, key)
    assert decrypted == plaintext


def test_encrypted_size():
    assert encrypted_size(14) == 16
    assert encrypted_size(16) == 32
    assert encrypted_size(100) == 112


def test_actual_encrypted_sizes():
    key = generate_aes_key()
    assert len(encrypt_aes_ecb(b"\x00" * 14, key)) == 16
    assert len(encrypt_aes_ecb(b"\x00" * 16, key)) == 32
    assert len(encrypt_aes_ecb(b"\x00" * 100, key)) == 112


def test_wrong_key_length():
    with pytest.raises(MediaError, match="16 bytes"):
        encrypt_aes_ecb(b"test", b"\x00" * 8)
    with pytest.raises(MediaError, match="16 bytes"):
        decrypt_aes_ecb(b"\x00" * 16, b"\x00" * 8)


def test_decode_format_a_base64_raw():
    raw = bytes.fromhex("00112233445566778899aabbccddeeff")
    import base64
    encoded = base64.b64encode(raw).decode()  # ABEiM0RVZneImaq7zN3u/w==
    decoded = decode_aes_key(encoded)
    assert decoded == raw


def test_decode_format_b_base64_hex():
    hex_str = "00112233445566778899aabbccddeeff"
    import base64
    encoded = base64.b64encode(hex_str.encode()).decode()
    decoded = decode_aes_key(encoded)
    assert decoded == bytes.fromhex(hex_str)


def test_decode_direct_hex():
    hex_str = "00112233445566778899aabbccddeeff"
    decoded = decode_aes_key(hex_str)
    assert decoded == bytes.fromhex(hex_str)
    assert len(decoded) == 16


def test_encode_aes_key_hex():
    key = bytes.fromhex("00112233445566778899aabbccddeeff")
    assert encode_aes_key_hex(key) == "00112233445566778899aabbccddeeff"


def test_encode_aes_key_base64():
    key = bytes.fromhex("00112233445566778899aabbccddeeff")
    result = encode_aes_key_base64(key)
    import base64
    decoded = base64.b64decode(result).decode("ascii")
    assert decoded == "00112233445566778899aabbccddeeff"

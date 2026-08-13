#pragma once

/**
 * @file BookProtection.h
 * @brief Detects DRM / store-locked book files without decrypting them.
 *
 * Inx reads unencrypted EPUB (plus TXT/MD/XTC). Purchased Kindle, Adobe ADEPT,
 * ACSM fulfillment, and Readium LCP packages cannot be opened. Font obfuscation
 * in encryption.xml is not DRM and is ignored.
 */

#include <cstddef>
#include <cstdint>
#include <string>

enum class BookProtectionKind : uint8_t {
  None = 0,
  AdobeAcsm,
  Kindle,
  ReadiumLcp,
  AdobeAdept,
  EncryptedEpub,
};

struct BookProtection {
  BookProtectionKind kind = BookProtectionKind::None;

  bool isProtected() const { return kind != BookProtectionKind::None; }

  /** Short e-ink popup. */
  const char* popupMessage() const;
};

/**
 * Classify an EPUB encryption.xml body. Font-obfuscation-only files return None.
 * `xml` may be a prefix of a larger document.
 */
BookProtectionKind classifyEncryptionXml(const char* xml, size_t length);

/** Inspect a file on the SD card by extension and, for EPUB, by package contents. */
BookProtection inspectBookProtection(const std::string& path);

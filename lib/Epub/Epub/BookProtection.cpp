/**
 * @file BookProtection.cpp
 * @brief Definitions for BookProtection.
 */

#include "BookProtection.h"

#include <Print.h>
#include <SDCardManager.h>
#include <ZipFile.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>

namespace {

bool endsWithIgnoreCase(const std::string& path, const char* ext) {
  const size_t extLen = std::strlen(ext);
  if (path.size() < extLen) {
    return false;
  }
  const char* tail = path.c_str() + (path.size() - extLen);
  for (size_t i = 0; i < extLen; ++i) {
    if (std::tolower(static_cast<unsigned char>(tail[i])) != std::tolower(static_cast<unsigned char>(ext[i]))) {
      return false;
    }
  }
  return true;
}

bool containsAscii(const char* haystack, size_t hayLen, const char* needle) {
  if (haystack == nullptr || needle == nullptr || needle[0] == '\0') {
    return false;
  }
  const size_t needleLen = std::strlen(needle);
  if (needleLen == 0 || hayLen < needleLen) {
    return false;
  }
  return std::search(haystack, haystack + hayLen, needle, needle + needleLen) != haystack + hayLen;
}

constexpr const char* kFontObfuscationNeedles[] = {
    "idpf.org/2008/embedding",
    "ns.adobe.com/pdf/enc#RC",
};

constexpr const char* kAdobeNeedles[] = {
    "ns.adobe.com/digitaleditions",
    "xmlenc#aes128-cbc",
    "ns.adobe.com/adept",
};

constexpr const char* kLcpNeedles[] = {
    "www.edrlab.org/lcp",
    "xmlenc#aes256-cbc",
};

constexpr const char* kContentUriNeedles[] = {
    ".xhtml",
    ".html",
    ".htm",
};

bool anyContains(const char* xml, size_t length, const char* const* needles, size_t needleCount) {
  for (size_t i = 0; i < needleCount; ++i) {
    if (containsAscii(xml, length, needles[i])) {
      return true;
    }
  }
  return false;
}

class EncryptionXmlScanner final : public Print {
 public:
  EncryptionXmlScanner() : buf_(static_cast<char*>(std::malloc(kCap))) {}
  ~EncryptionXmlScanner() { std::free(buf_); }

  bool ready() const { return buf_ != nullptr; }

  size_t write(uint8_t c) override { return write(&c, 1); }

  size_t write(const uint8_t* buffer, size_t size) override {
    if (buf_ == nullptr || buffer == nullptr || size == 0 || overflowed_) {
      return size;
    }
    if (used_ + size > kCap) {
      overflowed_ = true;
      size = kCap - used_;
    }
    if (size == 0) {
      return size;
    }
    std::memcpy(buf_ + used_, buffer, size);
    used_ += size;
    return size;
  }

  const char* data() const { return buf_ != nullptr ? buf_ : ""; }
  size_t size() const { return used_; }

 private:
  static constexpr size_t kCap = 12288;
  char* buf_;
  size_t used_ = 0;
  bool overflowed_ = false;
};

BookProtectionKind inspectEpubPackage(const std::string& path) {
  ZipFile zip(path);
  size_t ignored = 0;

  if (zip.getInflatedFileSize("META-INF/license.lcpl", &ignored)) {
    return BookProtectionKind::ReadiumLcp;
  }

  size_t encSize = 0;
  if (!zip.getInflatedFileSize("META-INF/encryption.xml", &encSize) || encSize == 0) {
    return BookProtectionKind::None;
  }

  EncryptionXmlScanner scanner;
  if (!scanner.ready()) {
    return BookProtectionKind::EncryptedEpub;
  }
  if (!zip.readFileToStream("META-INF/encryption.xml", scanner, 512)) {
    return BookProtectionKind::EncryptedEpub;
  }

  const BookProtectionKind fromXml = classifyEncryptionXml(scanner.data(), scanner.size());
  if (fromXml != BookProtectionKind::None) {
    return fromXml;
  }

  if (zip.getInflatedFileSize("META-INF/rights.xml", &ignored)) {
    return BookProtectionKind::AdobeAdept;
  }

  return BookProtectionKind::None;
}

bool fileLooksLikeAcsm(const std::string& path) {
  FsFile file;
  if (!SdMan.openFileForRead("DRM", path, file)) {
    return false;
  }
  char head[384];
  const int n = file.read(head, sizeof(head) - 1);
  file.close();
  if (n <= 0) {
    return false;
  }
  head[n] = '\0';
  return containsAscii(head, static_cast<size_t>(n), "ns.adobe.com/adept") ||
         containsAscii(head, static_cast<size_t>(n), "fulfillmentToken") ||
         containsAscii(head, static_cast<size_t>(n), "application/vnd.adobe.adept");
}

}  // namespace

const char* BookProtection::popupMessage() const {
  switch (kind) {
    case BookProtectionKind::AdobeAcsm:
      return "Adobe ACSM file, not a book.";
    case BookProtectionKind::Kindle:
      return "Kindle books are not supported.";
    case BookProtectionKind::ReadiumLcp:
      return "LCP-protected book.";
    case BookProtectionKind::AdobeAdept:
    case BookProtectionKind::EncryptedEpub:
      return "This book is DRM-protected.";
    case BookProtectionKind::None:
    default:
      return "Failed to open book.";
  }
}

BookProtectionKind classifyEncryptionXml(const char* xml, size_t length) {
  if (xml == nullptr || length == 0) {
    return BookProtectionKind::None;
  }

  const bool hasAdobe = anyContains(xml, length, kAdobeNeedles, sizeof(kAdobeNeedles) / sizeof(kAdobeNeedles[0]));
  const bool hasLcp = anyContains(xml, length, kLcpNeedles, sizeof(kLcpNeedles) / sizeof(kLcpNeedles[0]));
  const bool hasContentUri =
      anyContains(xml, length, kContentUriNeedles, sizeof(kContentUriNeedles) / sizeof(kContentUriNeedles[0]));
  const bool hasFontOnly = anyContains(xml, length, kFontObfuscationNeedles,
                                       sizeof(kFontObfuscationNeedles) / sizeof(kFontObfuscationNeedles[0]));

  if (hasLcp) {
    return BookProtectionKind::ReadiumLcp;
  }
  if (hasAdobe) {
    return BookProtectionKind::AdobeAdept;
  }
  if (hasContentUri) {
    return BookProtectionKind::EncryptedEpub;
  }
  if (hasFontOnly) {
    return BookProtectionKind::None;
  }
  if (containsAscii(xml, length, "EncryptedData") || containsAscii(xml, length, "encrypteddata")) {
    return BookProtectionKind::EncryptedEpub;
  }
  return BookProtectionKind::None;
}

BookProtection inspectBookProtection(const std::string& path) {
  BookProtection result;

  if (endsWithIgnoreCase(path, ".acsm") || endsWithIgnoreCase(path, ".lcpl")) {
    result.kind = endsWithIgnoreCase(path, ".lcpl") ? BookProtectionKind::ReadiumLcp : BookProtectionKind::AdobeAcsm;
    return result;
  }

  if (endsWithIgnoreCase(path, ".azw") || endsWithIgnoreCase(path, ".azw3") || endsWithIgnoreCase(path, ".kfx") ||
      endsWithIgnoreCase(path, ".kcr")) {
    result.kind = BookProtectionKind::Kindle;
    return result;
  }

  if (endsWithIgnoreCase(path, ".epub")) {
    if (fileLooksLikeAcsm(path)) {
      result.kind = BookProtectionKind::AdobeAcsm;
      return result;
    }
    result.kind = inspectEpubPackage(path);
    return result;
  }

  return result;
}

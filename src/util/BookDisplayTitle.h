#pragma once

/**
 * @file BookDisplayTitle.h
 * @brief Resolve a human book title from EPUB metadata / recent / book state.
 *
 * Library lists must never prefer the on-disk filename when a real OPF (or
 * previously stored) title is available. Archive dump filenames (Anna's Archive,
 * ISBN/hash suffixes) are stripped so the UI shows only the work's title.
 */

#include <Epub/BookMetadataCache.h>

#include <algorithm>
#include <cctype>
#include <string>

#include "state/BookState.h"
#include "state/RecentBooks.h"
#include "util/StringUtils.h"

namespace BookDisplayTitle {

inline std::string epubCachePath(const std::string& bookPath) {
  return "/.metadata/epub/" + std::to_string(std::hash<std::string>{}(bookPath));
}

inline std::string stripExtension(const std::string& name) {
  std::string out = name;
  const size_t slash = out.find_last_of("/\\");
  if (slash != std::string::npos) {
    out = out.substr(slash + 1);
  }
  const size_t dot = out.find_last_of('.');
  if (dot != std::string::npos && dot > 0) {
    const std::string ext = out.substr(dot);
    if (ext.size() <= 5) {
      out.resize(dot);
    }
  }
  return out;
}

inline std::string collapseSpaces(const std::string& value) {
  std::string out;
  out.reserve(value.size());
  bool space = false;
  for (unsigned char c : value) {
    if (std::isspace(c)) {
      space = true;
      continue;
    }
    if (space && !out.empty()) {
      out.push_back(' ');
    }
    space = false;
    out.push_back(static_cast<char>(c));
  }
  return out;
}

inline bool isHexBlob(const std::string& value) {
  if (value.size() < 16) {
    return false;
  }
  for (unsigned char c : value) {
    if (!std::isxdigit(c)) {
      return false;
    }
  }
  return true;
}

inline bool looksLikeJunkSegment(const std::string& segment) {
  std::string lower;
  lower.reserve(segment.size());
  for (unsigned char c : segment) {
    lower.push_back(static_cast<char>(std::tolower(c)));
  }
  if (lower.find("anna") != std::string::npos && lower.find("archive") != std::string::npos) {
    return true;
  }
  if (lower.find("z-library") != std::string::npos || lower.find("zlib") != std::string::npos) {
    return true;
  }
  if (lower.find("isbn") != std::string::npos) {
    return true;
  }
  if (isHexBlob(segment)) {
    return true;
  }
  return false;
}

/** Strip archive dump suffixes and keep the work's title. */
inline std::string clean(const std::string& raw) {
  std::string value = collapseSpaces(stripExtension(raw));
  if (value.empty()) {
    return {};
  }

  const std::string delim = " -- ";
  const size_t cut = value.find(delim);
  if (cut != std::string::npos) {
    std::string head = collapseSpaces(value.substr(0, cut));
    if (!head.empty() && !looksLikeJunkSegment(head)) {
      value = head;
    }
  }

  const size_t isbn = value.find(" isbn");
  if (isbn != std::string::npos && isbn > 8) {
    value = collapseSpaces(value.substr(0, isbn));
  }

  while (!value.empty() && (value.back() == '-' || value.back() == '_' || value.back() == '.')) {
    value.pop_back();
  }
  value = collapseSpaces(value);
  return value;
}

/** Returns OPF / cached title when present; empty string otherwise. */
inline std::string lookup(const std::string& bookPath) {
  if (bookPath.empty()) {
    return {};
  }

  if (StringUtils::checkFileExtension(bookPath, ".epub")) {
    BookMetadataCache metadata(epubCachePath(bookPath));
    if (metadata.load() && !metadata.coreMetadata.title.empty()) {
      return clean(metadata.coreMetadata.title);
    }
  }

  RECENT_BOOKS.loadFromFile();
  for (const RecentBook& book : RECENT_BOOKS.getBooks()) {
    if (book.path == bookPath && !book.title.empty()) {
      return clean(book.title);
    }
  }

  BookState::Book book;
  if (BOOK_STATE.findBook(bookPath, book) && !book.title.empty()) {
    return clean(book.title);
  }

  return {};
}

/** Prefer cached metadata title; otherwise keep a cleaned filename-based fallback. */
inline std::string resolve(const std::string& bookPath, const std::string& fallback) {
  const std::string title = lookup(bookPath);
  if (!title.empty()) {
    return title;
  }
  return clean(fallback);
}

}  // namespace BookDisplayTitle

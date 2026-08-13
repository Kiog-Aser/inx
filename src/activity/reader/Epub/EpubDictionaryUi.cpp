#include "EpubDictionaryUi.h"

#include <EpdFontFamily.h>
#include <Epub/Page.h>
#include <Epub/PageWordIndex.h>
#include <GfxRenderer.h>
#include <HalGPIO.h>

#include <algorithm>
#include <cctype>
#include <cstring>
#include <new>

#include <Arduino.h>
#include <esp_task_wdt.h>

#include "EpubActivity.h"
#include "WordOverlayNav.h"
#include "dictionary/DictionaryDefinitionLayout.h"
#include "state/SavedDictionaryWords.h"
#include "state/ReaderSetting.h"
#include "state/SystemSetting.h"
#include "system/FontManager.h"
#include "system/Fonts.h"
#include "system/MappedInputManager.h"

namespace {

constexpr unsigned long kChordHoldMs = 600;
constexpr int kHighlightLatticeStepPx = 2;

// Shared between performLookup() (to lay out definitionLines_ once, at the width it'll actually be
// rendered at) and drawDefinitionPanel() (to size/draw the panel itself).
constexpr int kDefinitionPanelMargin = 16;
constexpr int kDefinitionPanelPad = 20;

std::string stripHtmlToPlain(const std::string& html) {
  std::string out;
  out.reserve(html.size());
  bool inTag = false;
  for (unsigned char c : html) {
    if (c == '<') {
      inTag = true;
      continue;
    }
    if (c == '>') {
      inTag = false;
      if (!out.empty() && out.back() != ' ') {
        out.push_back(' ');
      }
      continue;
    }
    if (!inTag) {
      out.push_back(static_cast<char>(c));
    }
  }
  return out;
}

}  // namespace

EpubDictionaryUi::EpubDictionaryUi() = default;

void EpubDictionaryUi::tryChordEnter(EpubActivity& act) {
  if (!act.epub || !act.section || mode_) {
    return;
  }
  // DOWN+LEFT (annotations already owns DOWN+RIGHT) so the two live overlays never collide.
  const bool down = act.mappedInput.rawHalIsPressed(HalGPIO::BTN_DOWN);
  const bool left = act.mappedInput.rawHalIsPressed(HalGPIO::BTN_LEFT);
  if (down && left) {
    if (chordStartMs_ == 0) {
      chordStartMs_ = millis();
    }
    // Start opening the dictionary while the chord is still held so Confirm is a RAM/SD seek,
    // not a multi-second .idx scan. Warm open() is a no-op.
    if (millis() - chordStartMs_ >= 80 && ESP.getFreeHeap() > 80000) {
      ensureDictionaryOpen();
    }
    if (!chordConsumed_ && millis() - chordStartMs_ >= kChordHoldMs) {
      enter(act);
      chordConsumed_ = true;
    }
  } else {
    chordStartMs_ = 0;
    chordConsumed_ = false;
  }
}

void EpubDictionaryUi::prepareWordGeometry(EpubActivity& act) {
  if (!act.section || !act.epub) {
    return;
  }
  const ViewportInfo info = act.calculateViewport();
  const int fontId = act.bookSettings.getReaderFontId();
  const int headerFontId = FontManager::getNextFont(fontId);
  const int mt = info.totalMarginTop;
  const int ml = info.totalMarginLeft;

  auto page = act.section->loadPageFromSectionFile();
  if (!page) {
    words_.clear();
    lineFirst_.clear();
    return;
  }
  constexpr bool omitStoredWordStrings = false;
  buildPageWordIndex(*page, act.renderer, fontId, headerFontId, ml, mt, words_, &lineFirst_, omitStoredWordStrings);
}

void EpubDictionaryUi::captureFramebuffer(EpubActivity& act) {
  for (auto& ch : captureChunks_) {
    ch.reset();
  }
  captureMonolithic_.reset();
  captureUsesMonolithic_ = false;
  captureBytes_ = 0;
  captureValid_ = false;

  act.renderer.resetTransientReaderState();

  uint8_t* fb = act.renderer.getFrameBuffer();
  const size_t n = act.renderer.getBufferSize();
  if (!fb || n == 0) {
    return;
  }

  const size_t chunkCount = (n + kCaptureChunkBytes - 1) / kCaptureChunkBytes;
  captureChunks_.resize(chunkCount);

  bool chunkedOk = true;
  for (size_t i = 0; i < chunkCount; ++i) {
    const size_t offset = i * kCaptureChunkBytes;
    const size_t chunkBytes = std::min(kCaptureChunkBytes, n - offset);
    uint8_t* const buf = new (std::nothrow) uint8_t[chunkBytes];
    if (!buf) {
      chunkedOk = false;
      for (size_t j = 0; j < i; ++j) {
        captureChunks_[j].reset();
      }
      break;
    }
    memcpy(buf, fb + offset, chunkBytes);
    captureChunks_[i].reset(buf);
  }

  if (chunkedOk) {
    captureBytes_ = n;
    captureValid_ = true;
    return;
  }

  captureMonolithic_.reset(new (std::nothrow) uint8_t[n]);
  if (!captureMonolithic_) {
    return;
  }
  memcpy(captureMonolithic_.get(), fb, n);
  captureUsesMonolithic_ = true;
  captureBytes_ = n;
  captureValid_ = true;
}

void EpubDictionaryUi::enter(EpubActivity& act) {
  if (!act.section || !act.epub) {
    return;
  }
  // The Down+Left entry chord (and a plain long-press Down) leave the button held while
  // handleInput() is about to stop running for the whole overlay session - reset its per-button
  // state now so it doesn't misfire a stale long-press the instant this overlay exits.
  act.btnBindings_.reset();
  mode_ = true;
  showingDefinition_ = false;
  lookedUpWord_.clear();
  releaseDefinitionMemory();
  focus_ = 0;
  lastNavEdgeDir_ = -1;
  navRepeatDir_ = -1;

  prepareWordGeometry(act);
  if (words_.empty()) {
    act.readerPopup("No text to look up");
    exit(act);
    return;
  }
  captureFramebuffer(act);
  if (!captureValid_) {
    act.readerPopup("Could not capture page");
    exit(act);
    return;
  }
  act.updateRequired = true;
}

void EpubDictionaryUi::exit(EpubActivity& act) {
  mode_ = false;
  showingDefinition_ = false;
  lookedUpWord_.clear();
  releaseDefinitionMemory();
  std::vector<PageWordHit>().swap(words_);
  std::vector<size_t>().swap(lineFirst_);
  // Keep dict_ open for the rest of the book session: reopening rebuilds the checkpoint index with a
  // full .idx scan, which is the cold-path cost we just paid on the first lookup. RAM held is tens of
  // KB of checkpoints; reclaimed when the reader activity is destroyed (dict_ is a member).
  lastNavEdgeDir_ = -1;
  navRepeatDir_ = -1;
  for (auto& ch : captureChunks_) {
    ch.reset();
  }
  std::vector<std::unique_ptr<uint8_t[]>>().swap(captureChunks_);
  captureMonolithic_.reset();
  captureUsesMonolithic_ = false;
  captureBytes_ = 0;
  captureValid_ = false;
  act.updateRequired = true;
}

/** See header - swaps with a default-constructed temporary rather than .clear(), so the heap
 *  capacity a big definition needed is actually returned instead of sitting reserved for reuse. */
void EpubDictionaryUi::releaseDefinitionMemory() {
  std::string().swap(currentDefinition_);
  std::vector<DefinitionBlock>().swap(definitionBlocks_);
  std::vector<DefinitionStyledLine>().swap(definitionLines_);
  definitionScrollLine_ = 0;
  definitionScrollable_ = false;
}

void EpubDictionaryUi::ensureDictionaryOpen() {
  if (READER_SETTINGS.dictionaryFolder[0] == '\0') {
    Serial.printf("[%lu] [DICT] ensureDictionaryOpen: READER_SETTINGS.dictionaryFolder is empty\n", millis());
    return;
  }
  const std::string folder = std::string("/dictionaries/") + READER_SETTINGS.dictionaryFolder;
  // open() is a no-op when the same folder is already warm - safe to call every lookup.
  if (dict_.isOpen() && dict_.folderPath() == folder) {
    return;
  }
  const bool opened = dict_.open(folder);
  Serial.printf("[%lu] [DICT] ensureDictionaryOpen: open('%s') -> %d\n", millis(), folder.c_str(), opened ? 1 : 0);
}

void EpubDictionaryUi::performLookup(EpubActivity& act) {
  if (words_.empty() || focus_ >= words_.size()) {
    return;
  }
  lookedUpWord_ = StarDictLookup::stripSurroundingPunctuation(words_[focus_].text);
  currentDefinition_.clear();
  definitionScrollLine_ = 0;
  wordAlreadySaved_ = !lookedUpWord_.empty() && SAVED_WORDS.contains(lookedUpWord_);
  esp_task_wdt_reset();

  bool truncated = false;
  if (lookedUpWord_.empty()) {
    currentDefinition_ = "Nothing to look up.";
  } else if (READER_SETTINGS.dictionaryFolder[0] == '\0') {
    currentDefinition_ = "No dictionary selected. Pick one in Settings > Reader > Choose dictionary.";
  } else if (ESP.getFreeHeap() < 28000) {
    currentDefinition_ = "Not enough memory for dictionary lookup.";
  } else {
    const std::string folder = std::string("/dictionaries/") + READER_SETTINGS.dictionaryFolder;
    const bool alreadyWarm = dict_.isOpen() && dict_.folderPath() == folder;
    if (!alreadyWarm) {
      act.readerPopup(StarDictLookup::needsIndexBuild(folder) ? "Indexing dictionary..."
                                                             : "Opening dictionary...");
    }
    ensureDictionaryOpen();
    esp_task_wdt_reset();
    if (!dict_.isOpen()) {
      currentDefinition_ = "Could not open the selected dictionary.";
    } else if (!dict_.lookup(lookedUpWord_, currentDefinition_, &truncated)) {
      currentDefinition_ = "No definition found.";
    }
  }
  if (truncated) {
    // Back off from a cut that landed mid-UTF-8-codepoint (dictionaries are full of accented
    // letters, IPA symbols, en/em dashes) so we never hand a malformed byte sequence to the parser.
    while (!currentDefinition_.empty()) {
      const auto last = static_cast<unsigned char>(currentDefinition_.back());
      if ((last & 0xC0) == 0x80) {
        currentDefinition_.pop_back();  // continuation byte - still mid-sequence
        continue;
      }
      if (last >= 0xC0) {
        currentDefinition_.pop_back();  // orphaned lead byte - its continuation got cut off
      }
      break;
    }
    currentDefinition_ += " \xE2\x80\xA6";
  }

  const bool parseHtml = ESP.getMaxAllocHeap() > 24000 && ESP.getFreeHeap() > 36000 &&
                         currentDefinition_.find('<') != std::string::npos;
  if (parseHtml) {
    definitionBlocks_ = parseHtmlToBlocks(currentDefinition_);
  } else {
    DefinitionBlock block;
    block.kind = DefinitionBlockKind::Paragraph;
    block.runs.push_back(DefinitionTextRun(stripHtmlToPlain(currentDefinition_), EpdFontFamily::REGULAR));
    definitionBlocks_.clear();
    definitionBlocks_.push_back(std::move(block));
  }
  const int textWidth =
      (act.renderer.getScreenWidth() - kDefinitionPanelMargin * 2) - kDefinitionPanelPad * 2;
  if (ESP.getMaxAllocHeap() > 16000) {
    definitionLines_ = layoutDefinitionBlocks(act.renderer, definitionBlocks_, textWidth);
  } else {
    definitionLines_.clear();
  }
  if (definitionLines_.empty()) {
    std::string plain = stripHtmlToPlain(currentDefinition_);
    if (plain.empty()) {
      plain = currentDefinition_;
    }
    if (!plain.empty()) {
      const std::string clipped =
          act.renderer.text.truncate(ATKINSON_HYPERLEGIBLE_10_FONT_ID, plain.c_str(), std::max(1, textWidth));
      DefinitionStyledLine line;
      line.fontId = ATKINSON_HYPERLEGIBLE_10_FONT_ID;
      line.atoms.push_back(DefinitionTextAtom(clipped.empty() ? plain : clipped, EpdFontFamily::REGULAR, false, false));
      definitionLines_.push_back(std::move(line));
    }
  }
  showingDefinition_ = true;
  act.updateRequired = true;
}

bool EpubDictionaryUi::tryNavigationHoldRepeat(EpubActivity& act) {
  WordOverlayNav::EdgeState edge{lastNavEdgeMs_, lastNavEdgeDir_};
  const int nav = WordOverlayNav::handleDpad(
      act.mappedInput, edge, navRepeatDir_, navRepeatNextMs_, millis(),
      [this](const int delta) { moveFocusWord(delta); },
      [this](const int delta, const bool wrap) { moveFocusLine(delta, wrap); });
  lastNavEdgeMs_ = edge.lastMs;
  lastNavEdgeDir_ = edge.lastDir;
  if (nav == 2) {
    act.updateRequired = true;
  }
  return nav != 0;
}

/** Saves lookedUpWord_ to the global saved-words list (idempotent - a repeat Confirm on an
 *  already-saved word is a no-op). Just the word is stored, not the definition; the Recent activity's
 *  Dictionary list re-looks it up on open, so it stays correct even if the user switches dictionaries
 *  later - see SavedDictionaryWords.h. */
void EpubDictionaryUi::saveCurrentWord(EpubActivity& act) {
  if (lookedUpWord_.empty() || wordAlreadySaved_) {
    return;
  }
  if (SAVED_WORDS.add(lookedUpWord_, currentDefinition_)) {
    wordAlreadySaved_ = true;
    act.updateRequired = true;
  }
}

void EpubDictionaryUi::moveFocusWord(const int delta) {
  WordOverlayNav::moveFocusWord(words_, focus_, delta);
}

void EpubDictionaryUi::moveFocusLine(const int delta, const bool wrap) {
  WordOverlayNav::moveFocusLine(words_, lineFirst_, focus_, delta, wrap);
}

void EpubDictionaryUi::handleInput(EpubActivity& act) {
  const MappedInputManager& m = act.mappedInput;

  if (m.wasReleased(MappedInputManager::Button::Back)) {
    if (showingDefinition_) {
      showingDefinition_ = false;
      releaseDefinitionMemory();
      act.updateRequired = true;
    } else {
      exit(act);
      act.startPageTimer();
    }
    return;
  }
  if (m.wasReleased(MappedInputManager::Button::Confirm)) {
    if (showingDefinition_) {
      saveCurrentWord(act);
    } else {
      performLookup(act);
    }
    act.updateRequired = true;
    return;
  }
  if (showingDefinition_) {
    // Word navigation is frozen while a definition is on screen; Up/Down instead scroll long
    // definitions that don't fully fit (drawDefinitionPanel clamps the range each frame).
    constexpr size_t kScrollLinesPerPress = 3;
    if (m.wasPressed(MappedInputManager::Button::Up)) {
      definitionScrollLine_ = (definitionScrollLine_ > kScrollLinesPerPress) ? definitionScrollLine_ - kScrollLinesPerPress : 0;
      act.updateRequired = true;
    } else if (m.wasPressed(MappedInputManager::Button::Down)) {
      definitionScrollLine_ += kScrollLinesPerPress;
      act.updateRequired = true;
    }
    return;
  }
  if (tryNavigationHoldRepeat(act)) {
    return;
  }
}

void EpubDictionaryUi::repaint(EpubActivity& act) {
  if (!mode_) {
    return;
  }
  const size_t n = act.renderer.getBufferSize();
  if (!captureValid_ || captureBytes_ != n) {
    act.renderScreen(true);
    return;
  }
  uint8_t* fb = act.renderer.getFrameBuffer();
  if (!fb) {
    act.renderScreen(true);
    return;
  }
  act.renderer.setRenderMode(GfxRenderer::BW);
  if (captureUsesMonolithic_) {
    if (!captureMonolithic_) {
      act.renderScreen(true);
      return;
    }
    memcpy(fb, captureMonolithic_.get(), n);
  } else {
    const size_t chunkCount = (n + kCaptureChunkBytes - 1) / kCaptureChunkBytes;
    if (captureChunks_.size() != chunkCount) {
      act.renderScreen(true);
      return;
    }
    for (size_t i = 0; i < chunkCount; ++i) {
      const size_t offset = i * kCaptureChunkBytes;
      const size_t chunkBytes = std::min(kCaptureChunkBytes, n - offset);
      if (!captureChunks_[i]) {
        act.renderScreen(true);
        return;
      }
      memcpy(fb + offset, captureChunks_[i].get(), chunkBytes);
    }
  }
  drawUiOverlay(act);
}

void EpubDictionaryUi::drawFocusHighlight(EpubActivity& act) {
  if (words_.empty() || focus_ >= words_.size()) {
    return;
  }
  const PageWordHit& w = words_[focus_];
  act.renderer.ui.fillSparseInkLatticeInRect(w.screenX, std::max(0, w.screenY), std::max(1, w.screenW),
                                             std::max(3, w.screenH), kHighlightLatticeStepPx);
}

void EpubDictionaryUi::drawDefinitionPanel(EpubActivity& act) {
  const int screenW = act.renderer.getScreenWidth();
  const int screenH = act.renderer.getScreenHeight();
  constexpr int margin = kDefinitionPanelMargin;
  constexpr int pad = kDefinitionPanelPad;
  const int panelX = margin;
  const int panelW = screenW - margin * 2;
  const int panelBottom = screenH - margin - 40;  // leave room for the button-hint row below
  const int defaultPanelTop = screenH * 2 / 5;    // panel height used for short definitions
  const int minPanelTop = margin;                 // panel can grow up to near the top of the screen

  const int titleFontId = ATKINSON_HYPERLEGIBLE_12_FONT_ID;
  const int titleH = act.renderer.text.getLineHeight(titleFontId);
  // definitionLines_ is computed once per lookup (performLookup()), not recomputed here every frame.
  const auto& styledLines = definitionLines_;

  int contentH = 0;
  for (const DefinitionStyledLine& sl : styledLines) {
    contentH += act.renderer.text.getLineHeight(sl.fontId) + sl.extraGapBeforePx;
  }

  // Grow the panel to fit the content (up to minPanelTop), instead of always using the default size
  // and truncating - only falls back to scrolling if the content doesn't fit even at max height.
  constexpr int kTitleGapPx = 8;  // gap above and below the separator line under the title
  const int neededPanelH = pad * 2 + titleH + kTitleGapPx * 2 + contentH;
  const int defaultPanelH = panelBottom - defaultPanelTop;
  const int maxPanelH = panelBottom - minPanelTop;
  const int panelH = std::min(maxPanelH, std::max(defaultPanelH, neededPanelH));
  const int panelTop = panelBottom - panelH;

  // Same sharp-corner white-fill + black-border panel style as the menu/settings drawers
  // (MenuDrawer/SettingsDrawer background), not a rounded popup box.
  act.renderer.rectangle.fill(panelX, panelTop, panelW, panelH, false);
  act.renderer.rectangle.render(panelX, panelTop, panelW, panelH, true);

  int y = panelTop + pad + titleH;
  act.renderer.text.render(titleFontId, panelX + pad, y - titleH, lookedUpWord_.c_str(), true, EpdFontFamily::BOLD);
  if (wordAlreadySaved_) {
    const int tagFontId = ATKINSON_HYPERLEGIBLE_8_FONT_ID;
    const char* tag = "\xE2\x98\x85 Saved";  // "* Saved"
    const int tagW = act.renderer.text.getWidth(tagFontId, tag);
    const int tagY = y - titleH + (titleH - act.renderer.text.getLineHeight(tagFontId)) / 2;
    act.renderer.text.render(tagFontId, panelX + panelW - pad - tagW, tagY, tag, true);
  }
  y += kTitleGapPx;
  act.renderer.line.render(panelX + pad, y, panelX + panelW - pad, y, true, LineRender::Style::Dotted);
  y += kTitleGapPx;

  const int contentBottom = panelTop + panelH - pad;
  const int availableH = contentBottom - y;

  // Clamp scroll so the last screenful is always fully populated - walk backward from the end,
  // accumulating line heights, to find the furthest offset that still fills the available height.
  int maxScrollLine = 0;
  {
    int hFromEnd = 0;
    int idx = static_cast<int>(styledLines.size()) - 1;
    while (idx >= 0) {
      const int lh = act.renderer.text.getLineHeight(styledLines[idx].fontId) + styledLines[idx].extraGapBeforePx;
      if (hFromEnd + lh > availableH) {
        break;
      }
      hFromEnd += lh;
      --idx;
    }
    maxScrollLine = idx + 1;
  }
  definitionScrollable_ = maxScrollLine > 0;
  definitionScrollLine_ = std::min(definitionScrollLine_, static_cast<size_t>(maxScrollLine));

  renderStyledLines(act.renderer, styledLines, panelX + pad, y, contentBottom, definitionScrollLine_);
}

void EpubDictionaryUi::drawUiOverlay(EpubActivity& act) {
  if (!mode_) {
    return;
  }
  const GfxRenderer::Orientation o = act.renderer.getOrientation();
  if (showingDefinition_) {
    drawDefinitionPanel(act);
  } else {
    drawFocusHighlight(act);
  }
  act.renderer.setOrientation(GfxRenderer::Portrait);
  const char* back = showingDefinition_ ? "Close" : "Exit";
  const char* mid = showingDefinition_ ? (wordAlreadySaved_ ? "Saved" : "Save") : "Look up";
  const auto labels = act.mappedInput.mapLabels(back, mid, "Prev", "Next");
  act.renderer.ui.buttonHints(ATKINSON_HYPERLEGIBLE_10_FONT_ID, labels.btn1, labels.btn2, labels.btn3, labels.btn4);
  const bool showUpDown = !showingDefinition_ || definitionScrollable_;
  act.renderer.ui.sideButtonHints(ATKINSON_HYPERLEGIBLE_10_FONT_ID, "", showUpDown ? "Up" : "", showUpDown ? "Down" : "");
  act.renderer.setOrientation(o);
  act.renderer.displayBuffer(HalDisplay::FAST_REFRESH);
}

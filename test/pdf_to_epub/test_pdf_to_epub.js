#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "../..");
const fixturesDir = path.join(__dirname, "fixtures");
const converter = require(path.join(root, "data/js/pdf_to_epub.js"));

function fail(message) {
  console.error("FAIL:", message);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function loadPdf(name) {
  return fs.readFileSync(path.join(fixturesDir, name));
}

async function main() {
  const generated = spawnSync("python3", [path.join(__dirname, "generate_fixtures.py")], {
    encoding: "utf8",
  });
  if (generated.status !== 0) {
    fail("fixture generation failed: " + (generated.stderr || generated.stdout));
  }

  const simple = await converter.extract(loadPdf("simple_hello.pdf"));
  assert(simple.title === "Simple Hello", "simple title, got " + JSON.stringify(simple.title));
  assert(simple.author === "Inx Tests", "simple author");
  const simpleText = simple.pages.map((p) => p.paragraphs.join(" ")).join(" ");
  assert(simpleText.indexOf("Hello from Inx PDF import") !== -1, "simple text, got " + JSON.stringify(simpleText));

  const flate = await converter.extract(loadPdf("flate_hello.pdf"));
  const flateText = flate.pages.map((p) => p.paragraphs.join(" ")).join(" ");
  assert(flate.title === "Flate Hello", "flate title");
  assert(flateText.indexOf("Compressed") !== -1, "flate Compressed, got " + JSON.stringify(flateText));
  assert(flateText.indexOf("text PDF") !== -1, "flate TJ second part, got " + JSON.stringify(flateText));

  const multi = await converter.extract(loadPdf("multipage.pdf"));
  assert(multi.pages.length === 2, "two pages");
  assert(multi.outline.length === 2, "two outline entries, got " + JSON.stringify(multi.outline));
  assert(multi.outline[0].title === "Chapter One", "outline 1");
  assert(multi.outline[1].title === "Chapter Two", "outline 2");
  assert(multi.pages[0].paragraphs.join(" ").indexOf("Chapter one") !== -1, "page 1 text");
  assert(multi.pages[1].paragraphs.join(" ").indexOf("Chapter two") !== -1, "page 2 text");

  const empty = await converter.extract(loadPdf("empty_page.pdf"));
  const emptyText = empty.pages.map((p) => p.paragraphs.join("")).join("");
  assert(!emptyText, "empty page should have no text");

  try {
    await converter.toEpubBlob(loadPdf("empty_page.pdf"), { filename: "empty.pdf", JSZip: null });
    fail("empty PDF should not package without JSZip or text");
  } catch (err) {
    assert(/JSZip|No readable text/.test(err.message), "expected conversion error, got " + err.message);
  }

  try {
    await converter.toEpubBlob(loadPdf("empty_page.pdf"), { filename: "empty.pdf", JSZip: function FakeZip() {} });
    fail("empty PDF should refuse to build an EPUB");
  } catch (err) {
    assert(/No readable text/.test(err.message), "empty conversion message: " + err.message);
  }

  let JSZip;
  try {
    JSZip = require(path.join(root, "data/js/jszip.min.js"));
  } catch (err) {
    JSZip = null;
  }
  if (JSZip) {
    const packed = await converter.toEpubBlob(loadPdf("simple_hello.pdf"), {
      filename: "simple_hello.pdf",
      JSZip: JSZip,
      zipType: "uint8array",
    });
    assert(packed.filename === "simple_hello.epub", "epub filename");
    assert(packed.chapterCount === 1, "one chapter");
    const zip = await JSZip.loadAsync(packed.blob);
    assert(!!zip.file("mimetype"), "mimetype present");
    assert(!!zip.file("OEBPS/content.opf"), "opf present");
    const xhtml = await zip.file("OEBPS/Text/ch001.xhtml").async("string");
    assert(xhtml.indexOf("Hello from Inx PDF import") !== -1, "xhtml contains extracted text");
  }

  console.log("pdf_to_epub tests passed");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

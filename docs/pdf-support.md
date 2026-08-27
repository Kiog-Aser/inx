# PDF Support

The Xteink X3/X4 is an ESP32-C3 reader with about 380 KB of usable RAM and no
PSRAM. That is enough for EPUB reflow. It is not enough for a real PDF page
viewer, zoom/pan, or on-device OCR.

Inx still lets you read many PDFs by converting them to EPUB in the browser on
the **Epub** page of the local web interface. The device then reads the EPUB
with the normal reader fonts, layout, bookmarks, and progress.

## What works

Use a **born-digital PDF with selectable text**, or a scan that already has an
OCR text layer. On a computer, check that you can highlight words in a PDF
viewer before importing.

The converter:

- Extracts text and packages it as EPUB 2
- Uses PDF title/author metadata when present
- Splits chapters from the PDF outline when that outline points at pages
- Runs entirely in your browser, including on the device hotspot (no internet
  required)

## What does not work

- Opening a `.pdf` file from the on-device library. Copying a PDF to the SD
  card does not make it readable.
- Image-only scans, comics, magazines, and other files where the page image
  *is* the content
- Password-protected or AES-encrypted PDFs
- Preserving the original PDF layout, fonts, or page numbers
- Extracting figures, vector art, or scanned pages as images

Complex multi-column layouts are flattened into reading order. That is usually
fine for articles and reports, and a poor fit for textbooks or sheet music.

## How to import a PDF

1. On the device, open **File Transfer** and join Wi-Fi or start the hotspot.
2. In a desktop browser, open the device web UI and go to **Epub**.
3. Drop a `.pdf` file onto the page, or use **Add Books**.
4. Wait for “Converted … -> ….epub”, then the upload.
5. Open the new EPUB from the library. The original PDF is not stored.

You can mix `.epub` and `.pdf` files in the same import.

## If conversion fails

| Message | What to do |
| --- | --- |
| **No readable text was found in this PDF** | Run OCR on a computer (Calibre, OCRmyPDF, or a PDF editor), or convert to EPUB with Calibre and upload the EPUB. |
| **Password-protected PDFs are not supported** | Save an unencrypted copy you are allowed to read, then import that file. |
| **This PDF uses unsupported compression** | Print/save a PDF 1.4 copy, or convert with Calibre. |
| **This file is not a PDF** / **damaged** | Replace the file with a known-good copy. |

Calibre’s “Convert books” to EPUB is the most reliable path for difficult
files, DRM-free Kindle/Kobo exports, and anything with important images.

## Why this is browser-side

A full PDF renderer (MuPDF, pdf.js on-device, zoomable page images) needs more
RAM than the ESP32-C3 has. CrossPDF-style on-device reflow is a large firmware
feature of its own. Inx keeps PDF handling in the web importer so the reader
stays an EPUB-first firmware that still accepts everyday text PDFs.

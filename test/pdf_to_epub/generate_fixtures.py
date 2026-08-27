#!/usr/bin/env python3
"""Build tiny PDFs used by test/pdf_to_epub/test_pdf_to_epub.js."""

from __future__ import annotations

import zlib
from pathlib import Path


def xref_entry(offset: int, used: bool, gen: int = 0) -> bytes:
    flag = b"n" if used else b"f"
    return f"{offset:010d} {gen:05d} {flag.decode()} \n".encode("ascii")


def assemble(objects: dict[int, bytes], root: int, info: int | None = None) -> bytes:
    header = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    body = bytearray(header)
    offsets = {0: 0}
    for num in sorted(objects):
        offsets[num] = len(body)
        body.extend(f"{num} 0 obj\n".encode("ascii"))
        body.extend(objects[num])
        body.extend(b"\nendobj\n")

    xref_pos = len(body)
    size = max(objects) + 1
    body.extend(f"xref\n0 {size}\n".encode("ascii"))
    body.extend(xref_entry(0, False, 65535))
    for num in range(1, size):
        body.extend(xref_entry(offsets[num], True))

    trailer = f"<< /Size {size} /Root {root} 0 R"
    if info is not None:
        trailer += f" /Info {info} 0 R"
    trailer += " >>"
    body.extend(b"trailer\n")
    body.extend(trailer.encode("ascii"))
    body.extend(f"\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii"))
    return bytes(body)


def content_stream(commands: str, flate: bool = False) -> bytes:
    raw = commands.encode("latin1")
    if not flate:
        return f"<< /Length {len(raw)} >>\nstream\n".encode("ascii") + raw + b"\nendstream"
    compressed = zlib.compress(raw)
    return (
        f"<< /Length {len(compressed)} /Filter /FlateDecode >>\nstream\n".encode("ascii")
        + compressed
        + b"\nendstream"
    )


def simple_hello() -> bytes:
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        ),
        4: content_stream("BT /F1 12 Tf 72 720 Td (Hello from Inx PDF import) Tj ET\n"),
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        6: b"<< /Title (Simple Hello) /Author (Inx Tests) >>",
    }
    return assemble(objects, root=1, info=6)


def flate_hello() -> bytes:
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        ),
        4: content_stream("BT /F1 14 Tf 72 700 Td [(Compressed ) -320 (text PDF)] TJ ET\n", flate=True),
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>",
        6: b"<< /Title (Flate Hello) >>",
    }
    return assemble(objects, root=1, info=6)


def multipage() -> bytes:
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>"
        ),
        4: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>"
        ),
        5: content_stream("BT /F1 12 Tf 72 720 Td (Chapter one body text.) Tj ET\n"),
        6: content_stream("BT /F1 12 Tf 72 720 Td (Chapter two body text.) Tj ET\n"),
        7: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        8: b"<< /Title (Two Chapters) /Author (Fixture) >>",
        9: b"<< /Type /Outlines /Count 2 /First 10 0 R /Last 11 0 R >>",
        10: b"<< /Title (Chapter One) /Parent 9 0 R /Next 11 0 R /Dest [3 0 R /XYZ 0 792 0] >>",
        11: b"<< /Title (Chapter Two) /Parent 9 0 R /Prev 10 0 R /Dest [4 0 R /XYZ 0 792 0] >>",
    }
    return assemble(objects, root=1, info=8)


def empty_page() -> bytes:
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
        4: b"<< /Title (Empty) >>",
    }
    return assemble(objects, root=1, info=4)


def main() -> None:
    out_dir = Path(__file__).resolve().parent / "fixtures"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "simple_hello.pdf").write_bytes(simple_hello())
    (out_dir / "flate_hello.pdf").write_bytes(flate_hello())
    (out_dir / "multipage.pdf").write_bytes(multipage())
    (out_dir / "empty_page.pdf").write_bytes(empty_page())
    print(f"Wrote fixtures to {out_dir}")


if __name__ == "__main__":
    main()

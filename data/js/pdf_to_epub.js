/**
 * Convert a text PDF into a reflowable EPUB for Inx.
 *
 * This is not a page-accurate PDF viewer. It extracts selectable text (and a
 * table of contents when present) and packages it as EPUB 2. Image-only scans,
 * passworded files, and unsupported encodings cannot be converted here.
 */
(function (root) {
  "use strict";

  var PDF_WHITESPACE = /[\x00\t\n\f\r ]/;
  var MAX_PAGES = 4000;
  var MAX_INFLATE = 8 * 1024 * 1024;
  var PARAGRAPH_Y_FACTOR = 1.25;
  var TJ_SPACE_THRESHOLD = -120;

  var WINANSI = buildWinAnsi();
  var MACROMAN = buildMacRoman();
  var STANDARD = buildStandardEncoding();
  var PDFDOC = buildPdfDocEncoding();
  var GLYPHS = buildGlyphNames();

  function latin1(bytes, start, end) {
    start = start || 0;
    end = end === undefined ? bytes.length : end;
    var out = "";
    for (var i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }

  function bytesOfString(text) {
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  function concatBytes(parts) {
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], offset);
      offset += parts[i].length;
    }
    return out;
  }

  function xmlEscape(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function basenameNoExt(name) {
    var base = String(name || "document").replace(/^.*[\\/]/, "");
    return base.replace(/\.pdf$/i, "") || "document";
  }

  function isRef(value) {
    return value && typeof value === "object" && value.__ref === true;
  }

  function isName(value) {
    return value && typeof value === "object" && value.__name === true;
  }

  function isDict(value) {
    return value && typeof value === "object" && value.__dict === true;
  }

  function isStream(value) {
    return value && typeof value === "object" && value.__stream === true;
  }

  function nameOf(value) {
    return isName(value) ? value.n : "";
  }

  function dictGet(dict, key) {
    if (!isDict(dict)) return undefined;
    return dict.v[key];
  }

  function asNumber(value, fallback) {
    return typeof value === "number" && isFinite(value) ? value : fallback;
  }

  function inflateBytes(bytes) {
    if (!bytes || !bytes.length) return Promise.resolve(new Uint8Array(0));
    if (bytes.length > MAX_INFLATE) {
      return Promise.reject(new Error("This PDF uses a compressed stream that is too large to convert safely."));
    }
    if (typeof DecompressionStream !== "undefined") {
      return inflateWithDecompressionStream(bytes, "deflate").catch(function () {
        return inflateWithDecompressionStream(bytes, "deflate-raw");
      });
    }
    if (typeof require === "function") {
      try {
        var zlib = require("zlib");
        try {
          return Promise.resolve(new Uint8Array(zlib.inflateSync(Buffer.from(bytes))));
        } catch (err) {
          return Promise.resolve(new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes))));
        }
      } catch (err2) {
        return Promise.reject(err2);
      }
    }
    return Promise.reject(new Error("This PDF uses Flate compression, which this browser cannot decompress."));
  }

  function inflateWithDecompressionStream(bytes, format) {
    var ds = new DecompressionStream(format);
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function asciiHexDecode(bytes) {
    var hex = "";
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i];
      if (c === 0x3e) break;
      if (c > 32) hex += String.fromCharCode(c);
    }
    if (hex.length % 2) hex += "0";
    var out = new Uint8Array(hex.length / 2);
    for (var j = 0; j < out.length; j++) out[j] = parseInt(hex.substr(j * 2, 2), 16);
    return out;
  }

  function ascii85Decode(bytes) {
    var out = [];
    var acc = 0;
    var n = 0;
    var i = 0;
    if (bytes[0] === 0x3c && bytes[1] === 0x7e) i = 2;
    for (; i < bytes.length; i++) {
      var c = bytes[i];
      if (c <= 32) continue;
      if (c === 0x7e && bytes[i + 1] === 0x3e) break;
      if (c === 0x7a) {
        if (n) throw new Error("This PDF uses unsupported ASCII85 compression.");
        out.push(0, 0, 0, 0);
        continue;
      }
      if (c < 33 || c > 117) continue;
      acc = acc * 85 + (c - 33);
      n++;
      if (n === 5) {
        out.push((acc >>> 24) & 0xff, (acc >>> 16) & 0xff, (acc >>> 8) & 0xff, acc & 0xff);
        acc = 0;
        n = 0;
      }
    }
    if (n) {
      for (var pad = n; pad < 5; pad++) acc = acc * 85 + 84;
      for (var k = 0; k < n - 1; k++) out.push((acc >>> (24 - 8 * k)) & 0xff);
    }
    return new Uint8Array(out);
  }

  function runLengthDecode(bytes) {
    var out = [];
    var i = 0;
    while (i < bytes.length) {
      var len = bytes[i++];
      if (len === 128) break;
      if (len < 128) {
        var copy = len + 1;
        for (var j = 0; j < copy && i < bytes.length; j++) out.push(bytes[i++]);
      } else {
        var count = 257 - len;
        var b = bytes[i++];
        for (var k = 0; k < count; k++) out.push(b);
      }
    }
    return new Uint8Array(out);
  }

  function applyPredictor(data, params) {
    var predictor = asNumber(dictGet(params, "Predictor"), 1);
    if (!params || predictor <= 1) return data;
    var columns = asNumber(dictGet(params, "Columns"), 1);
    var colors = asNumber(dictGet(params, "Colors"), 1);
    var bpc = asNumber(dictGet(params, "BitsPerComponent"), 8);
    var row = Math.ceil((columns * colors * bpc) / 8);
    if (row <= 0) return data;
    if (predictor === 2) {
      var tiff = new Uint8Array(data);
      for (var y = 0; y < tiff.length; y += row) {
        for (var x = colors; x < row && y + x < tiff.length; x++) {
          tiff[y + x] = (tiff[y + x] + tiff[y + x - colors]) & 0xff;
        }
      }
      return tiff;
    }
    if (predictor < 10 || predictor > 15) return data;
    var stride = row + 1;
    var rows = Math.floor(data.length / stride);
    var out = new Uint8Array(rows * row);
    var prev = new Uint8Array(row);
    for (var r = 0; r < rows; r++) {
      var filter = data[r * stride];
      var cur = data.subarray(r * stride + 1, r * stride + 1 + row);
      var dest = out.subarray(r * row, r * row + row);
      for (var c = 0; c < row; c++) {
        var left = c ? dest[c - 1] : 0;
        var up = prev[c];
        var upLeft = c ? prev[c - 1] : 0;
        var val = cur[c];
        if (filter === 1) val = (val + left) & 0xff;
        else if (filter === 2) val = (val + up) & 0xff;
        else if (filter === 3) val = (val + ((left + up) >> 1)) & 0xff;
        else if (filter === 4) val = (val + paeth(left, up, upLeft)) & 0xff;
        dest[c] = val;
      }
      prev = dest.slice();
    }
    return out;
  }

  function paeth(a, b, c) {
    var p = a + b - c;
    var pa = Math.abs(p - a);
    var pb = Math.abs(p - b);
    var pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  function skipWsAndComments(bytes, pos) {
    var n = bytes.length;
    while (pos < n) {
      var c = bytes[pos];
      if (c === 0x25) {
        pos++;
        while (pos < n && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos++;
        continue;
      }
      if (c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20) {
        pos++;
        continue;
      }
      break;
    }
    return pos;
  }

  function isDelim(c) {
    return (
      c === 0x28 ||
      c === 0x29 ||
      c === 0x3c ||
      c === 0x3e ||
      c === 0x5b ||
      c === 0x5d ||
      c === 0x7b ||
      c === 0x7d ||
      c === 0x2f ||
      c === 0x25
    );
  }

  function parseName(bytes, pos) {
    pos++;
    var out = "";
    while (pos < bytes.length) {
      var c = bytes[pos];
      if (c <= 32 || isDelim(c)) break;
      if (c === 0x23 && pos + 2 < bytes.length) {
        out += String.fromCharCode(parseInt(latin1(bytes, pos + 1, pos + 3), 16));
        pos += 3;
        continue;
      }
      out += String.fromCharCode(c);
      pos++;
    }
    return { value: { __name: true, n: out }, pos: pos };
  }

  function parseLiteralString(bytes, pos) {
    pos++;
    var depth = 1;
    var out = [];
    while (pos < bytes.length && depth > 0) {
      var c = bytes[pos++];
      if (c === 0x5c) {
        if (pos >= bytes.length) break;
        var n = bytes[pos++];
        if (n >= 0x30 && n <= 0x37) {
          var oct = String.fromCharCode(n);
          for (var i = 0; i < 2 && pos < bytes.length && bytes[pos] >= 0x30 && bytes[pos] <= 0x37; i++) {
            oct += String.fromCharCode(bytes[pos++]);
          }
          out.push(parseInt(oct, 8) & 0xff);
        } else if (n === 0x6e) out.push(0x0a);
        else if (n === 0x72) out.push(0x0d);
        else if (n === 0x74) out.push(0x09);
        else if (n === 0x62) out.push(0x08);
        else if (n === 0x66) out.push(0x0c);
        else if (n === 0x0d) {
          if (bytes[pos] === 0x0a) pos++;
        } else if (n === 0x0a) {
          /* escaped newline */
        } else out.push(n);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth > 0) out.push(c);
      } else out.push(c);
    }
    return { value: { __str: true, b: new Uint8Array(out) }, pos: pos };
  }

  function parseHexString(bytes, pos) {
    pos++;
    var hex = "";
    while (pos < bytes.length) {
      var c = bytes[pos++];
      if (c === 0x3e) break;
      if (c > 32) hex += String.fromCharCode(c);
    }
    if (hex.length % 2) hex += "0";
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return { value: { __str: true, b: out }, pos: pos };
  }

  function parseNumberOrRef(bytes, pos, reader) {
    var start = pos;
    if (bytes[pos] === 0x2b || bytes[pos] === 0x2d) pos++;
    while (pos < bytes.length && bytes[pos] >= 0x30 && bytes[pos] <= 0x39) pos++;
    if (bytes[pos] === 0x2e) {
      pos++;
      while (pos < bytes.length && bytes[pos] >= 0x30 && bytes[pos] <= 0x39) pos++;
    }
    var num = parseFloat(latin1(bytes, start, pos));
    var peek = skipWsAndComments(bytes, pos);
    if (bytes[peek] >= 0x30 && bytes[peek] <= 0x39) {
      var genStart = peek;
      var genPos = peek;
      while (genPos < bytes.length && bytes[genPos] >= 0x30 && bytes[genPos] <= 0x39) genPos++;
      var afterGen = skipWsAndComments(bytes, genPos);
      var next = bytes[afterGen];
      if (next === 0x52 && (afterGen + 1 >= bytes.length || bytes[afterGen + 1] <= 32 || isDelim(bytes[afterGen + 1]))) {
        var gen = parseInt(latin1(bytes, genStart, genPos), 10);
        return { value: { __ref: true, num: num | 0, gen: gen | 0 }, pos: afterGen + 1 };
      }
    }
    return { value: num, pos: pos };
  }

  function parseToken(bytes, pos, reader) {
    pos = skipWsAndComments(bytes, pos);
    if (pos >= bytes.length) return { value: undefined, pos: pos, done: true };
    var c = bytes[pos];
    if (c === 0x2f) return parseName(bytes, pos);
    if (c === 0x28) return parseLiteralString(bytes, pos);
    if (c === 0x3c && bytes[pos + 1] === 0x3c) return parseDict(bytes, pos, reader);
    if (c === 0x3c) return parseHexString(bytes, pos);
    if (c === 0x5b) return parseArray(bytes, pos, reader);
    if (c === 0x74 && latin1(bytes, pos, pos + 4) === "true") return { value: true, pos: pos + 4 };
    if (c === 0x66 && latin1(bytes, pos, pos + 5) === "false") return { value: false, pos: pos + 5 };
    if (c === 0x6e && latin1(bytes, pos, pos + 4) === "null") return { value: null, pos: pos + 4 };
    if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) return parseNumberOrRef(bytes, pos, reader);
    var ident = "";
    while (pos < bytes.length && bytes[pos] > 32 && !isDelim(bytes[pos])) ident += String.fromCharCode(bytes[pos++]);
    return { value: ident, pos: pos };
  }

  function parseArray(bytes, pos, reader) {
    pos++;
    var arr = [];
    while (pos < bytes.length) {
      pos = skipWsAndComments(bytes, pos);
      if (bytes[pos] === 0x5d) return { value: arr, pos: pos + 1 };
      var tok = parseToken(bytes, pos, reader);
      if (tok.done) break;
      arr.push(tok.value);
      pos = tok.pos;
    }
    return { value: arr, pos: pos };
  }

  function parseDict(bytes, pos, reader) {
    pos += 2;
    var dict = { __dict: true, v: {} };
    while (pos < bytes.length) {
      pos = skipWsAndComments(bytes, pos);
      if (bytes[pos] === 0x3e && bytes[pos + 1] === 0x3e) {
        pos += 2;
        pos = skipWsAndComments(bytes, pos);
        if (latin1(bytes, pos, pos + 6) === "stream") {
          pos += 6;
          if (bytes[pos] === 0x0d) pos++;
          if (bytes[pos] === 0x0a) pos++;
          var lengthVal = dictGet(dict, "Length");
          var length = 0;
          if (typeof lengthVal === "number") length = lengthVal;
          else if (isRef(lengthVal) && reader) length = asNumber(reader.getObjectSync(lengthVal), 0);
          var data = bytes.subarray(pos, Math.min(bytes.length, pos + length));
          pos += length;
          pos = skipWsAndComments(bytes, pos);
          if (latin1(bytes, pos, pos + 9) === "endstream") pos += 9;
          return { value: { __stream: true, dict: dict, data: data }, pos: pos };
        }
        return { value: dict, pos: pos };
      }
      var keyTok = parseToken(bytes, pos, reader);
      if (!isName(keyTok.value)) break;
      var valTok = parseToken(bytes, keyTok.pos, reader);
      dict.v[keyTok.value.n] = valTok.value;
      pos = valTok.pos;
    }
    return { value: dict, pos: pos };
  }

  function pdfStringToUnicode(strObj) {
    if (!strObj) return "";
    if (typeof strObj === "string") return strObj;
    var bytes = strObj.__str ? strObj.b : strObj;
    if (!(bytes instanceof Uint8Array)) return String(strObj);
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      var utf16 = "";
      for (var i = 2; i + 1 < bytes.length; i += 2) {
        var code = (bytes[i] << 8) | bytes[i + 1];
        if (code) utf16 += String.fromCharCode(code);
      }
      return utf16;
    }
    var out = "";
    for (var j = 0; j < bytes.length; j++) out += String.fromCharCode(PDFDOC[bytes[j]] || bytes[j]);
    return out;
  }

  function PdfReader(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.xref = new Map();
    this.cache = new Map();
    this.objStmCache = new Map();
    this.trailer = null;
    this.warnings = [];
  }

  PdfReader.prototype.warn = function (message) {
    if (this.warnings.indexOf(message) === -1) this.warnings.push(message);
  };

  PdfReader.prototype.key = function (num, gen) {
    return num + " " + (gen || 0);
  };

  PdfReader.prototype.readHeader = function () {
    var head = latin1(this.bytes, 0, Math.min(this.bytes.length, 16));
    if (head.indexOf("%PDF-") !== 0) throw new Error("This file is not a PDF.");
  };

  PdfReader.prototype.findStartXref = function () {
    var start = Math.max(0, this.bytes.length - 4096);
    var tail = latin1(this.bytes, start, this.bytes.length);
    var idx = tail.lastIndexOf("startxref");
    if (idx < 0) throw new Error("This PDF is damaged or cannot be read safely.");
    var rest = tail.slice(idx + 9).replace(/^\s+/, "");
    var offset = parseInt(rest, 10);
    if (!isFinite(offset) || offset < 0 || offset >= this.bytes.length) {
      throw new Error("This PDF is damaged or cannot be read safely.");
    }
    return offset;
  };

  PdfReader.prototype.parseXrefTable = function (pos) {
    pos += 4;
    while (pos < this.bytes.length) {
      pos = skipWsAndComments(this.bytes, pos);
      if (latin1(this.bytes, pos, pos + 7) === "trailer") break;
      var tok1 = parseToken(this.bytes, pos, this);
      var tok2 = parseToken(this.bytes, tok1.pos, this);
      if (typeof tok1.value !== "number" || typeof tok2.value !== "number") break;
      var start = tok1.value | 0;
      var count = tok2.value | 0;
      pos = skipWsAndComments(this.bytes, tok2.pos);
      for (var i = 0; i < count; i++) {
        var line = latin1(this.bytes, pos, Math.min(this.bytes.length, pos + 20));
        var offset = parseInt(line.substr(0, 10), 10);
        var gen = parseInt(line.substr(11, 5), 10);
        var flag = line.charAt(17);
        if (flag === "n") this.xref.set(this.key(start + i, gen), { type: 1, offset: offset, gen: gen });
        pos += 20;
        if (this.bytes[pos] === 0x0d) pos++;
        if (this.bytes[pos] === 0x0a) pos++;
      }
    }
    pos = skipWsAndComments(this.bytes, pos);
    if (latin1(this.bytes, pos, pos + 7) !== "trailer") throw new Error("This PDF is damaged or cannot be read safely.");
    var trailerTok = parseToken(this.bytes, pos + 7, this);
    return { trailer: trailerTok.value, pos: trailerTok.pos };
  };

  PdfReader.prototype.loadXref = function () {
    var self = this;
    var offset = this.findStartXref();
    return this.loadXrefAt(offset).then(function (trailer) {
      self.trailer = trailer;
      if (dictGet(trailer, "Encrypt")) {
        throw new Error("Password-protected PDFs are not supported. Save an unencrypted copy, then import it again.");
      }
    });
  };

  PdfReader.prototype.loadXrefAt = function (offset) {
    var self = this;
    var pos = skipWsAndComments(this.bytes, offset);
    if (latin1(this.bytes, pos, pos + 4) === "xref") {
      var table = this.parseXrefTable(pos);
      var prev = dictGet(table.trailer, "Prev");
      if (typeof prev === "number") {
        return this.loadXrefAt(prev).then(function () {
          return table.trailer;
        });
      }
      return Promise.resolve(table.trailer);
    }
    var obj = this.parseIndirectAt(pos);
    if (!obj || !isStream(obj.value)) throw new Error("This PDF is damaged or cannot be read safely.");
    this.xref.set(this.key(obj.num, obj.gen), { type: 1, offset: pos, gen: obj.gen });
    return decodeStream(this, obj.value).then(function (decoded) {
      ingestXrefStream(self, obj.value.dict, decoded);
      var prev = dictGet(obj.value.dict, "Prev");
      var trailer = obj.value.dict;
      if (typeof prev === "number") {
        return self.loadXrefAt(prev).then(function () {
          return trailer;
        });
      }
      return trailer;
    });
  };

  function ingestXrefStream(reader, dict, data) {
    var w = dictGet(dict, "W") || [1, 2, 1];
    var size = asNumber(dictGet(dict, "Size"), 0);
    var index = dictGet(dict, "Index") || [0, size];
    var entrySize = 0;
    var i;
    for (i = 0; i < w.length; i++) entrySize += asNumber(w[i], 0);
    var cursor = 0;
    function readField(width) {
      if (!width) return 0;
      var value = 0;
      for (var k = 0; k < width; k++) value = (value << 8) | data[cursor++];
      return value;
    }
    for (i = 0; i + 1 < index.length; i += 2) {
      var start = index[i] | 0;
      var count = index[i + 1] | 0;
      for (var n = 0; n < count; n++) {
        if (cursor + entrySize > data.length) return;
        var type = w[0] ? readField(w[0]) : 1;
        var field2 = readField(w[1] || 0);
        var field3 = readField(w[2] || 0);
        if (type === 1) reader.xref.set(reader.key(start + n, field3), { type: 1, offset: field2, gen: field3 });
        else if (type === 2) reader.xref.set(reader.key(start + n, 0), { type: 2, objstm: field2, index: field3, gen: 0 });
      }
    }
  }

  PdfReader.prototype.parseIndirectAt = function (pos) {
    var numTok = parseToken(this.bytes, pos, this);
    var genTok = parseToken(this.bytes, numTok.pos, this);
    var kwTok = parseToken(this.bytes, genTok.pos, this);
    if (kwTok.value !== "obj") return null;
    var valTok = parseToken(this.bytes, kwTok.pos, this);
    return { num: numTok.value | 0, gen: genTok.value | 0, value: valTok.value, pos: valTok.pos };
  };

  PdfReader.prototype.getObjectSync = function (ref) {
    if (!isRef(ref)) return ref;
    var key = this.key(ref.num, ref.gen);
    if (this.cache.has(key)) return this.cache.get(key);
    var loc = this.xref.get(key) || this.xref.get(this.key(ref.num, 0));
    if (!loc || loc.type !== 1) return null;
    var parsed = this.parseIndirectAt(loc.offset);
    if (!parsed) return null;
    this.cache.set(key, parsed.value);
    return parsed.value;
  };

  PdfReader.prototype.getObject = function (ref) {
    var self = this;
    if (!isRef(ref)) return Promise.resolve(ref);
    var key = this.key(ref.num, ref.gen);
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    var loc = this.xref.get(key) || this.xref.get(this.key(ref.num, 0));
    if (!loc) return Promise.resolve(null);
    if (loc.type === 1) {
      var parsed = this.parseIndirectAt(loc.offset);
      if (!parsed) return Promise.resolve(null);
      this.cache.set(key, parsed.value);
      return Promise.resolve(parsed.value);
    }
    if (loc.type === 2) {
      return this.loadObjStm(loc.objstm).then(function (objs) {
        var value = objs[loc.index];
        self.cache.set(key, value);
        return value;
      });
    }
    return Promise.resolve(null);
  };

  PdfReader.prototype.resolve = function (value) {
    var self = this;
    return this.getObject(value).then(function (obj) {
      if (isRef(obj)) return self.resolve(obj);
      return obj;
    });
  };

  PdfReader.prototype.loadObjStm = function (objNum) {
    var self = this;
    if (this.objStmCache.has(objNum)) return Promise.resolve(this.objStmCache.get(objNum));
    return this.getObject({ __ref: true, num: objNum, gen: 0 }).then(function (stream) {
      if (!isStream(stream)) return [];
      return decodeStream(self, stream).then(function (data) {
        var n = asNumber(dictGet(stream.dict, "N"), 0);
        var first = asNumber(dictGet(stream.dict, "First"), 0);
        var header = latin1(data, 0, first);
        var nums = header.trim().split(/\s+/);
        var objs = [];
        for (var i = 0; i < n; i++) {
          var offset = first + (parseInt(nums[i * 2 + 1], 10) || 0);
          var tok = parseToken(data, offset, self);
          objs.push(tok.value);
        }
        self.objStmCache.set(objNum, objs);
        return objs;
      });
    });
  };

  function filterList(dict) {
    var filter = dictGet(dict, "Filter") || dictGet(dict, "F");
    if (!filter) return [];
    if (isName(filter)) return [nameOf(filter)];
    if (Array.isArray(filter)) return filter.map(nameOf);
    return [];
  }

  function decodeParmsList(dict, count) {
    var parms = dictGet(dict, "DecodeParms") || dictGet(dict, "DP");
    if (!parms) return new Array(count);
    if (isDict(parms)) return [parms];
    if (Array.isArray(parms)) return parms;
    return new Array(count);
  }

  function decodeStream(reader, stream) {
    if (!isStream(stream)) return Promise.resolve(new Uint8Array(0));
    var filters = filterList(stream.dict);
    var parms = decodeParmsList(stream.dict, filters.length);
    var data = stream.data;
    var chain = Promise.resolve(data);
    filters.forEach(function (filter, idx) {
      chain = chain.then(function (current) {
        if (filter === "FlateDecode" || filter === "Fl") {
          return inflateBytes(current).then(function (inflated) {
            return applyPredictor(inflated, parms[idx]);
          });
        }
        if (filter === "ASCIIHexDecode" || filter === "AHx") return asciiHexDecode(current);
        if (filter === "ASCII85Decode" || filter === "A85") return ascii85Decode(current);
        if (filter === "RunLengthDecode" || filter === "RL") return runLengthDecode(current);
        throw new Error("This PDF uses unsupported compression (" + filter + ").");
      });
    });
    return chain;
  }

  PdfReader.prototype.collectPages = function (node, out) {
    var self = this;
    return this.resolve(node).then(function (obj) {
      var dict = isStream(obj) ? obj.dict : obj;
      if (!isDict(dict)) return out;
      var type = nameOf(dictGet(dict, "Type"));
      if (type === "Page") {
        out.push(dict);
        return out;
      }
      var kids = dictGet(dict, "Kids") || [];
      var chain = Promise.resolve();
      (Array.isArray(kids) ? kids : []).forEach(function (kid) {
        chain = chain.then(function () {
          if (out.length >= MAX_PAGES) return;
          return self.collectPages(kid, out);
        });
      });
      return chain.then(function () {
        return out;
      });
    });
  };

  function parseCmap(text) {
    var map = new Map();
    var width = 1;
    var space = /begincodespacerange\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(text);
    if (space) width = Math.ceil(space[1].length / 2);
    function hexToInt(hex) {
      return parseInt(hex, 16);
    }
    function hexToText(hex) {
      var clean = hex.replace(/[^0-9A-Fa-f]/g, "");
      if (clean.length % 2) clean = "0" + clean;
      var out = "";
      for (var i = 0; i < clean.length; i += 4) {
        var slice = clean.substr(i, 4);
        if (slice.length < 4) slice = clean.substr(i, 2);
        var code = parseInt(slice, 16);
        if (code) out += String.fromCharCode(code);
      }
      return out;
    }
    var bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
    var charMatch;
    while ((charMatch = bfchar.exec(text))) {
      var pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      var m;
      while ((m = pair.exec(charMatch[1]))) map.set(hexToInt(m[1]), hexToText(m[2]));
    }
    var bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
    var rangeMatch;
    while ((rangeMatch = bfrange.exec(text))) {
      var range = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
      var r;
      while ((r = range.exec(rangeMatch[1]))) {
        var start = hexToInt(r[1]);
        var end = hexToInt(r[2]);
        if (r[4]) {
          var dests = r[4].match(/<([0-9A-Fa-f]+)>/g) || [];
          for (var i = 0; i <= end - start && i < dests.length; i++) {
            map.set(start + i, hexToText(dests[i].replace(/[<>]/g, "")));
          }
        } else {
          var base = hexToInt(r[3]);
          for (var code = start; code <= end; code++) {
            map.set(code, String.fromCharCode(base + (code - start)));
          }
        }
      }
    }
    return { map: map, width: width };
  }

  function buildEncodingMap(encoding, reader) {
    var map = WINANSI.slice();
    if (!encoding) return Promise.resolve(map);
    if (isName(encoding)) {
      if (encoding.n === "WinAnsiEncoding") map = WINANSI.slice();
      else if (encoding.n === "MacRomanEncoding") map = MACROMAN.slice();
      else if (encoding.n === "StandardEncoding") map = STANDARD.slice();
      else if (encoding.n === "PDFDocEncoding") map = PDFDOC.slice();
      return Promise.resolve(map);
    }
    return reader.resolve(encoding).then(function (encDict) {
      if (!isDict(encDict)) return map;
      var base = dictGet(encDict, "BaseEncoding");
      if (isName(base)) {
        if (base.n === "MacRomanEncoding") map = MACROMAN.slice();
        else if (base.n === "StandardEncoding") map = STANDARD.slice();
        else if (base.n === "PDFDocEncoding") map = PDFDOC.slice();
        else map = WINANSI.slice();
      }
      var diffs = dictGet(encDict, "Differences") || [];
      var code = 0;
      diffs.forEach(function (item) {
        if (typeof item === "number") code = item | 0;
        else if (isName(item)) {
          map[code] = GLYPHS[item.n] || map[code] || code;
          code++;
        }
      });
      return map;
    });
  }

  PdfReader.prototype.loadFont = function (fontRef) {
    var self = this;
    return this.resolve(fontRef).then(function (font) {
      var dict = isStream(font) ? font.dict : font;
      if (!isDict(dict)) return { cmap: null, width: 1, encoding: WINANSI };
      var toUnicode = dictGet(dict, "ToUnicode");
      var encoding = dictGet(dict, "Encoding");
      var cmapPromise = Promise.resolve(null);
      if (toUnicode) {
        cmapPromise = self.resolve(toUnicode).then(function (stream) {
          if (!isStream(stream)) return null;
          return decodeStream(self, stream).then(function (data) {
            return parseCmap(latin1(data));
          });
        });
      }
      return Promise.all([cmapPromise, buildEncodingMap(encoding, self)]).then(function (parts) {
        return { cmap: parts[0], encoding: parts[1], width: parts[0] ? parts[0].width : 1 };
      });
    });
  };

  PdfReader.prototype.loadResourceFonts = function (resources) {
    var self = this;
    return this.resolve(resources).then(function (res) {
      var dict = isStream(res) ? res.dict : res;
      var fonts = dictGet(dict, "Font");
      return self.resolve(fonts).then(function (fontDict) {
        var out = {};
        if (!isDict(fontDict)) return out;
        var names = Object.keys(fontDict.v);
        var chain = Promise.resolve();
        names.forEach(function (name) {
          chain = chain.then(function () {
            return self.loadFont(fontDict.v[name]).then(function (font) {
              out[name] = font;
            });
          });
        });
        return chain.then(function () {
          return out;
        });
      });
    });
  };

  function decodeFontBytes(bytes, font) {
    if (!bytes) return "";
    if (font && font.cmap) {
      var out = "";
      var width = font.cmap.width || 1;
      for (var i = 0; i + width - 1 < bytes.length; i += width) {
        var code = 0;
        for (var w = 0; w < width; w++) code = (code << 8) | bytes[i + w];
        out += font.cmap.map.get(code) || "";
      }
      return out;
    }
    var encoding = (font && font.encoding) || WINANSI;
    var text = "";
    for (var j = 0; j < bytes.length; j++) {
      var mapped = encoding[bytes[j]];
      text += typeof mapped === "number" ? String.fromCharCode(mapped) : mapped || "";
    }
    return text;
  }

  function extractTextFromContent(content, fonts) {
    var pos = 0;
    var inText = false;
    var font = fonts.F1 || fonts[Object.keys(fonts)[0]] || { encoding: WINANSI, cmap: null, width: 1 };
    var fontSize = 12;
    var y = 0;
    var lastY = null;
    var paragraphs = [];
    var current = "";

    function pushParagraph() {
      var cleaned = current.replace(/[ \t]+\n/g, "\n").replace(/\s+/g, " ").trim();
      if (cleaned) paragraphs.push(cleaned);
      current = "";
    }

    function addText(text) {
      if (!text) return;
      current += text;
    }

    function maybeBreak(nextY) {
      if (lastY !== null && Math.abs(lastY - nextY) > Math.max(8, fontSize * PARAGRAPH_Y_FACTOR)) pushParagraph();
      lastY = nextY;
      y = nextY;
    }

    var tokens = [];
    while (pos < content.length) {
      var t = parseToken(content, pos, null);
      if (t.done) break;
      tokens.push(t.value);
      pos = t.pos;
    }

    inText = false;
    var stack = [];
    function take(n) {
      return stack.splice(Math.max(0, stack.length - n), n);
    }

    tokens.forEach(function (token) {
      if (typeof token === "string") {
        if (token === "BT") {
          inText = true;
          stack = [];
          return;
        }
        if (token === "ET") {
          inText = false;
          return;
        }
        if (!inText) {
          stack = [];
          return;
        }
        if (token === "Tf") {
          var tf = take(2);
          var fontName = tf[0];
          fontSize = asNumber(tf[1], fontSize);
          if (isName(fontName) && fonts[fontName.n]) font = fonts[fontName.n];
          return;
        }
        if (token === "Td" || token === "TD") {
          var td = take(2);
          var dy = asNumber(td[1], 0);
          if (Math.abs(dy) > 0.1) maybeBreak(y + dy);
          else if (asNumber(td[0], 0) > fontSize * 0.4 && current && !/ $/.test(current)) addText(" ");
          return;
        }
        if (token === "Tm") {
          var tm = take(6);
          maybeBreak(asNumber(tm[5], y));
          return;
        }
        if (token === "T*") {
          maybeBreak(y - fontSize * PARAGRAPH_Y_FACTOR);
          return;
        }
        if (token === "Tj" || token === "'" || token === '"') {
          if (token === "'" || token === '"') maybeBreak(y - fontSize * PARAGRAPH_Y_FACTOR);
          var shown = take(token === '"' ? 3 : 1);
          var str = shown[shown.length - 1];
          if (str && str.__str) addText(decodeFontBytes(str.b, font));
          return;
        }
        if (token === "TJ") {
          var arr = take(1)[0];
          if (Array.isArray(arr)) {
            arr.forEach(function (item) {
              if (item && item.__str) addText(decodeFontBytes(item.b, font));
              else if (typeof item === "number" && item < TJ_SPACE_THRESHOLD && current && !/ $/.test(current)) addText(" ");
            });
          }
          return;
        }
        stack = [];
        return;
      }
      stack.push(token);
    });
    pushParagraph();
    return paragraphs;
  }

  PdfReader.prototype.pageContentBytes = function (page) {
    var self = this;
    var contents = dictGet(page, "Contents");
    if (!contents) return Promise.resolve(new Uint8Array(0));
    var refs = Array.isArray(contents) ? contents : [contents];
    var parts = [];
    var chain = Promise.resolve();
    refs.forEach(function (ref) {
      chain = chain.then(function () {
        return self.resolve(ref).then(function (obj) {
          if (!isStream(obj)) return;
          return decodeStream(self, obj).then(function (data) {
            parts.push(data);
          });
        });
      });
    });
    return chain.then(function () {
      return concatBytes(parts);
    });
  };

  PdfReader.prototype.extractPageText = function (page) {
    var self = this;
    var resources = dictGet(page, "Resources");
    return this.loadResourceFonts(resources)
      .then(function (fonts) {
        return self.pageContentBytes(page).then(function (content) {
          return extractTextFromContent(content, fonts);
        });
      })
      .catch(function (err) {
        self.warn(err.message || String(err));
        return [];
      });
  };

  PdfReader.prototype.extractOutline = function (catalog, pages) {
    var self = this;
    var outlines = dictGet(catalog, "Outlines");
    if (!outlines) return Promise.resolve([]);
    var pageIndex = new Map();
    pages.forEach(function (page, idx) {
      /* Page dict identity is enough for dest matching by object number later. */
      pageIndex.set(page, idx);
    });
    function destPageIndex(dest) {
      return self.resolve(dest).then(function (value) {
        if (typeof value === "string" || (value && value.__str)) {
          return self.resolve(dictGet(catalog, "Dests")).then(function (dests) {
            if (!isDict(dests)) return -1;
            var key = typeof value === "string" ? value : pdfStringToUnicode(value);
            return destPageIndex(dictGet(dests, key));
          });
        }
        if (Array.isArray(value) && value.length) {
          var first = value[0];
          if (isRef(first)) {
            return self.getObject(first).then(function (pageDict) {
              var dict = isStream(pageDict) ? pageDict.dict : pageDict;
              var idx = pages.indexOf(dict);
              return idx;
            });
          }
        }
        if (isDict(value) && dictGet(value, "D")) return destPageIndex(dictGet(value, "D"));
        return -1;
      });
    }
    function walk(itemRef, acc) {
      if (!itemRef) return Promise.resolve(acc);
      return self.resolve(itemRef).then(function (item) {
        if (!isDict(item)) return acc;
        var title = pdfStringToUnicode(dictGet(item, "Title")) || "Chapter";
        var dest = dictGet(item, "Dest") || dictGet(item, "A");
        return destPageIndex(dest)
          .then(function (idx) {
            acc.push({ title: title, pageIndex: Math.max(0, idx) });
            return walk(dictGet(item, "First"), acc);
          })
          .then(function () {
            return walk(dictGet(item, "Next"), acc);
          });
      });
    }
    return this.resolve(outlines).then(function (root) {
      if (!isDict(root)) return [];
      return walk(dictGet(root, "First"), []);
    });
  };

  PdfReader.prototype.extract = function () {
    var self = this;
    this.readHeader();
    return this.loadXref()
      .then(function () {
        return self.resolve(dictGet(self.trailer, "Root"));
      })
      .then(function (catalog) {
        if (!isDict(catalog)) throw new Error("This PDF is damaged or cannot be read safely.");
        self.catalog = catalog;
        return self.collectPages(dictGet(catalog, "Pages"), []).then(function (pages) {
          self.pages = pages;
          return self.resolve(dictGet(self.trailer, "Info")).then(function (info) {
            self.info = isDict(info) ? info : { __dict: true, v: {} };
            return pages;
          });
        });
      })
      .then(function (pages) {
        var pageTexts = [];
        var chain = Promise.resolve();
        pages.forEach(function (page, index) {
          chain = chain.then(function () {
            return self.extractPageText(page).then(function (paragraphs) {
              pageTexts.push({ index: index, paragraphs: paragraphs });
            });
          });
        });
        return chain.then(function () {
          return self.extractOutline(self.catalog, pages).then(function (outline) {
            return {
              title: pdfStringToUnicode(dictGet(self.info, "Title")) || "",
              author: pdfStringToUnicode(dictGet(self.info, "Author")) || "",
              pages: pageTexts,
              outline: outline,
              warnings: self.warnings.slice(),
            };
          });
        });
      });
  };

  function chapterId(index) {
    var n = String(index + 1);
    while (n.length < 3) n = "0" + n;
    return "ch" + n;
  }

  function chaptersFromExtract(extracted, fallbackTitle) {
    var pages = extracted.pages || [];
    var outline = extracted.outline || [];
    var chapters = [];
    function pageText(from, to) {
      var paras = [];
      for (var i = from; i < to; i++) {
        var page = pages[i];
        if (!page || !page.paragraphs.length) continue;
        paras = paras.concat(page.paragraphs);
      }
      return paras;
    }
    if (outline.length) {
      var starts = outline.map(function (item) {
        return Math.max(0, Math.min(pages.length - 1, item.pageIndex || 0));
      });
      for (var i = 0; i < outline.length; i++) {
        var start = starts[i];
        var end = i + 1 < starts.length ? Math.max(start + 1, starts[i + 1]) : pages.length;
        var paras = pageText(start, end);
        if (paras.length) chapters.push({ title: outline[i].title || "Chapter " + (i + 1), paragraphs: paras });
      }
    }
    if (!chapters.length) {
      var all = [];
      pages.forEach(function (page) {
        all = all.concat(page.paragraphs);
      });
      if (all.length) chapters.push({ title: fallbackTitle, paragraphs: all });
    }
    return chapters;
  }

  function buildXhtml(title, paragraphs) {
    var body = paragraphs
      .map(function (p) {
        return "<p>" + xmlEscape(p) + "</p>";
      })
      .join("\n");
    return (
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">\n' +
      "<head><title>" +
      xmlEscape(title) +
      "</title></head>\n<body>\n<h1>" +
      xmlEscape(title) +
      "</h1>\n" +
      body +
      "\n</body>\n</html>\n"
    );
  }

  function buildOpf(title, author, chapters) {
    var manifest = chapters
      .map(function (ch, i) {
        var id = chapterId(i);
        return '    <item id="' + id + '" href="Text/' + id + '.xhtml" media-type="application/xhtml+xml"/>';
      })
      .join("\n");
    var spine = chapters
      .map(function (ch, i) {
        var id = chapterId(i);
        return '    <itemref idref="' + id + '"/>';
      })
      .join("\n");
    return (
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n' +
      "    <dc:title>" +
      xmlEscape(title) +
      "</dc:title>\n" +
      "    <dc:creator>" +
      xmlEscape(author || "Unknown") +
      "</dc:creator>\n" +
      "    <dc:language>en</dc:language>\n" +
      '    <dc:identifier id="BookId">inx-pdf-' +
      xmlEscape(title).replace(/\s+/g, "-").slice(0, 40) +
      "</dc:identifier>\n" +
      "  </metadata>\n" +
      "  <manifest>\n" +
      '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n' +
      manifest +
      "\n  </manifest>\n" +
      '  <spine toc="ncx">\n' +
      spine +
      "\n  </spine>\n</package>\n"
    );
  }

  function buildNcx(title, chapters) {
    var points = chapters
      .map(function (ch, i) {
        var id = chapterId(i);
        return (
          '    <navPoint id="' +
          id +
          '" playOrder="' +
          (i + 1) +
          '">\n      <navLabel><text>' +
          xmlEscape(ch.title) +
          "</text></navLabel>\n      <content src=\"Text/" +
          id +
          '.xhtml"/>\n    </navPoint>'
        );
      })
      .join("\n");
    return (
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
      "  <head><meta name=\"dtb:uid\" content=\"inx-pdf\"/></head>\n" +
      "  <docTitle><text>" +
      xmlEscape(title) +
      "</text></docTitle>\n  <navMap>\n" +
      points +
      "\n  </navMap>\n</ncx>\n"
    );
  }

  function extractPdf(arrayBuffer) {
    var reader = new PdfReader(arrayBuffer);
    return reader.extract();
  }

  function toEpubBlob(arrayBuffer, options) {
    options = options || {};
    var zipCtor = options.JSZip || (typeof JSZip !== "undefined" ? JSZip : null);
    if (!zipCtor) return Promise.reject(new Error("JSZip is required to package the converted EPUB."));
    var fallbackTitle = basenameNoExt(options.filename);
    return extractPdf(arrayBuffer).then(function (extracted) {
      var chapters = chaptersFromExtract(extracted, fallbackTitle);
      var textLen = chapters.reduce(function (sum, ch) {
        return sum + ch.paragraphs.join(" ").length;
      }, 0);
      if (!textLen) {
        throw new Error(
          "No readable text was found in this PDF. Image-only scans need an OCR text layer; convert those with Calibre on a computer."
        );
      }
      var title = extracted.title || fallbackTitle;
      var author = extracted.author || "";
      var zip = new zipCtor();
      zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
      zip.file(
        "META-INF/container.xml",
        '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>\n'
      );
      zip.file("OEBPS/content.opf", buildOpf(title, author, chapters));
      zip.file("OEBPS/toc.ncx", buildNcx(title, chapters));
      chapters.forEach(function (ch, i) {
        var id = chapterId(i);
        zip.file("OEBPS/Text/" + id + ".xhtml", buildXhtml(ch.title, ch.paragraphs));
      });
      var zipType = options.zipType || (typeof Blob !== "undefined" ? "blob" : "uint8array");
      return zip.generateAsync({ type: zipType, compression: "DEFLATE", compressionOptions: { level: 6 } }).then(function (blob) {
        return {
          blob: blob,
          filename: fallbackTitle + ".epub",
          title: title,
          author: author,
          chapterCount: chapters.length,
          warnings: extracted.warnings || [],
        };
      });
    });
  }

  function fillLatin(map) {
    for (var i = 32; i < 127; i++) map[i] = i;
    return map;
  }

  function buildWinAnsi() {
    var map = fillLatin(new Array(256));
    var extra = {
      0x80: 0x20ac,
      0x82: 0x201a,
      0x83: 0x0192,
      0x84: 0x201e,
      0x85: 0x2026,
      0x86: 0x2020,
      0x87: 0x2021,
      0x88: 0x02c6,
      0x89: 0x2030,
      0x8a: 0x0160,
      0x8b: 0x2039,
      0x8c: 0x0152,
      0x8e: 0x017d,
      0x91: 0x2018,
      0x92: 0x2019,
      0x93: 0x201c,
      0x94: 0x201d,
      0x95: 0x2022,
      0x96: 0x2013,
      0x97: 0x2014,
      0x98: 0x02dc,
      0x99: 0x2122,
      0x9a: 0x0161,
      0x9b: 0x203a,
      0x9c: 0x0153,
      0x9e: 0x017e,
      0x9f: 0x0178,
    };
    Object.keys(extra).forEach(function (k) {
      map[k] = extra[k];
    });
    for (var i = 0xa0; i < 256; i++) if (!map[i]) map[i] = i;
    return map;
  }

  function buildMacRoman() {
    var map = fillLatin(new Array(256));
    var extra = {
      0x80: 0xc4,
      0x81: 0xc5,
      0x82: 0xc7,
      0x83: 0xc9,
      0x84: 0xd1,
      0x85: 0xd6,
      0x86: 0xdc,
      0x87: 0xe1,
      0x88: 0xe0,
      0x89: 0xe2,
      0x8a: 0xe4,
      0x8b: 0xe3,
      0x8c: 0xe5,
      0x8d: 0xe7,
      0x8e: 0xe9,
      0x8f: 0xe8,
      0x90: 0xea,
      0x91: 0xeb,
      0x92: 0xed,
      0x93: 0xec,
      0x94: 0xee,
      0x95: 0xef,
      0x96: 0xf1,
      0x97: 0xf3,
      0x98: 0xf2,
      0x99: 0xf4,
      0x9a: 0xf6,
      0x9b: 0xf5,
      0x9c: 0xfa,
      0x9d: 0xf9,
      0x9e: 0xfb,
      0x9f: 0xfc,
      0xa0: 0x2020,
      0xa1: 0xb0,
      0xa5: 0x2022,
      0xa8: 0xae,
      0xa9: 0xa9,
      0xaa: 0x2122,
      0xd0: 0x2013,
      0xd1: 0x2014,
      0xd2: 0x201c,
      0xd3: 0x201d,
      0xd4: 0x2018,
      0xd5: 0x2019,
    };
    Object.keys(extra).forEach(function (k) {
      map[k] = extra[k];
    });
    return map;
  }

  function buildStandardEncoding() {
    return fillLatin(new Array(256));
  }

  function buildPdfDocEncoding() {
    var map = fillLatin(new Array(256));
    for (var i = 0xa0; i < 256; i++) map[i] = i;
    map[0x18] = 0x02d8;
    map[0x19] = 0x02c7;
    map[0x1a] = 0x02c6;
    map[0x1b] = 0x02d9;
    map[0x1c] = 0x02dd;
    map[0x1d] = 0x02db;
    map[0x1e] = 0x02da;
    map[0x1f] = 0x02dc;
    return map;
  }

  function buildGlyphNames() {
    var map = {
      space: 32,
      exclam: 33,
      quotedbl: 34,
      numbersign: 35,
      dollar: 36,
      percent: 37,
      ampersand: 38,
      quotesingle: 39,
      parenleft: 40,
      parenright: 41,
      asterisk: 42,
      plus: 43,
      comma: 44,
      hyphen: 45,
      period: 46,
      slash: 47,
      colon: 58,
      semicolon: 59,
      less: 60,
      equal: 61,
      greater: 62,
      question: 63,
      at: 64,
      bracketleft: 91,
      backslash: 92,
      bracketright: 93,
      asciicircum: 94,
      underscore: 95,
      grave: 96,
      braceleft: 123,
      bar: 124,
      braceright: 125,
      asciitilde: 126,
      quoteleft: 0x2018,
      quoteright: 0x2019,
      quotedblleft: 0x201c,
      quotedblright: 0x201d,
      endash: 0x2013,
      emdash: 0x2014,
      bullet: 0x2022,
      ellipsis: 0x2026,
      fi: 0xfb01,
      fl: 0xfb02,
      dagger: 0x2020,
      daggerdbl: 0x2021,
      euro: 0x20ac,
      sterling: 0xa3,
      yen: 0xa5,
      cent: 0xa2,
      section: 0xa7,
      copyright: 0xa9,
      registered: 0xae,
      degree: 0xb0,
      plusminus: 0xb1,
      multiply: 0xd7,
      divide: 0xf7,
      AE: 0xc6,
      ae: 0xe6,
      OE: 0x0152,
      oe: 0x0153,
      germandbls: 0xdf,
      ss: 0xdf,
    };
    var i;
    for (i = 0; i < 26; i++) {
      map[String.fromCharCode(65 + i)] = 65 + i;
      map[String.fromCharCode(97 + i)] = 97 + i;
    }
    for (i = 0; i < 10; i++) map[["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][i]] = 48 + i;
    return map;
  }

  var api = {
    extract: extractPdf,
    toEpubBlob: toEpubBlob,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.InxPdfToEpub = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

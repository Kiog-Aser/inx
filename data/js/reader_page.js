(function () {
  const paper = document.getElementById("reader-paper");
  const tab = document.getElementById("reader-tab");
  const tocBox = document.getElementById("reader-toc");
  if (!paper) return;

  function bookPath() {
    try {
      return decodeURIComponent(new URLSearchParams(location.search).get("path") || "");
    } catch (_) {
      return "";
    }
  }

  function cleanTitle(value) {
    return window.InxShell && window.InxShell.cleanBookTitle
      ? window.InxShell.cleanBookTitle(value)
      : String(value || "").replace(/\.[A-Za-z0-9]{1,5}$/, "");
  }

  function dirOf(path) {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash + 1);
  }

  function resolveHref(base, href) {
    if (!href || /^(https?:|data:|blob:|#)/i.test(href)) return href;
    const parts = (dirOf(base) + href).split("/");
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "." || parts[i] === "") continue;
      if (parts[i] === "..") out.pop();
      else out.push(parts[i]);
    }
    return out.join("/");
  }

  function xmlAttr(tag, name) {
    const match = tag.match(new RegExp(name + "\\s*=\\s*[\"']([^\"']+)[\"']", "i"));
    return match ? match[1] : "";
  }

  async function zipText(zip, path) {
    const file = zip.file(path) || zip.file(decodeURIComponent(path));
    return file ? file.async("string") : "";
  }

  async function blobUrl(zip, path, mime) {
    const file = zip.file(path) || zip.file(decodeURIComponent(path));
    if (!file) return "";
    const blob = await file.async("blob");
    return URL.createObjectURL(new Blob([blob], { type: mime || blob.type || "application/octet-stream" }));
  }

  function wrapHighlights(root, texts) {
    const unique = [];
    (texts || []).forEach((text) => {
      const needle = String(text || "").replace(/\s+/g, " ").trim();
      if (needle.length > 12 && unique.indexOf(needle) === -1) unique.push(needle);
    });
    unique.slice(0, 80).forEach((needle) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const hay = node.nodeValue || "";
        const at = hay.toLowerCase().indexOf(needle.toLowerCase());
        if (at === -1) continue;
        try {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          const mark = document.createElement("mark");
          range.surroundContents(mark);
        } catch (_) {}
        break;
      }
    });
  }

  async function loadHighlights(path, title) {
    try {
      const res = await fetch("/api/export-notes");
      if (!res.ok) return [];
      const data = await res.json();
      return ((data && data.items) || []).filter((item) => {
        if (item.type && item.type !== "annotation") return false;
        if (path && item.path === path) return true;
        return title && item.book && cleanTitle(item.book).toLowerCase() === title.toLowerCase();
      });
    } catch (_) {
      return [];
    }
  }

  async function renderEpub(path) {
    paper.innerHTML = '<div class="reader-empty">Opening book…</div>';
    const res = await fetch("/download?path=" + encodeURIComponent(path));
    if (!res.ok) throw new Error("Unable to download book");
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    const containerXml = await zipText(zip, "META-INF/container.xml");
    const opfPath = xmlAttr((containerXml.match(/<rootfile\b[^>]*>/i) || [""])[0], "full-path");
    if (!opfPath) throw new Error("This EPUB is missing its package file");
    const opf = await zipText(zip, opfPath);
    const titleMatch = opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
    const title = cleanTitle(titleMatch ? titleMatch[1] : path);
    document.title = title + " — Inx";
    const titleEl = tab ? tab.querySelector("span") : null;
    if (titleEl) {
      titleEl.textContent = title;
    }

    const manifest = {};
    (opf.match(/<item\b[^>]*>/gi) || []).forEach((tag) => {
      const id = xmlAttr(tag, "id");
      const href = xmlAttr(tag, "href");
      if (id && href) manifest[id] = resolveHref(opfPath, href);
    });
    const spine = (opf.match(/<itemref\b[^>]*>/gi) || [])
      .map((tag) => manifest[xmlAttr(tag, "idref")])
      .filter(Boolean);

    const tocItems = [];
    (opf.match(/<navPoint[\s\S]*?<\/navPoint>/gi) || []).forEach((block) => {
      const label = (block.match(/<text>([^<]+)<\/text>/i) || [, ""])[1];
      const src = xmlAttr((block.match(/<content\b[^>]*>/i) || [""])[0], "src");
      if (label && src) tocItems.push({ label, href: resolveHref(opfPath, src.split("#")[0]) });
    });
    if (!tocItems.length) {
      const navFile = Object.keys(manifest).map((id) => manifest[id]).find((href) => /nav|toc/i.test(href));
      if (navFile) {
        const navHtml = await zipText(zip, navFile);
        (navHtml.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []).forEach((anchor) => {
          const href = xmlAttr(anchor, "href");
          const label = anchor.replace(/<[^>]+>/g, "").trim();
          if (href && label) tocItems.push({ label, href: resolveHref(navFile, href.split("#")[0]) });
        });
      }
    }

    if (tocBox) {
      tocBox.innerHTML = tocItems
        .map((item, index) => '<a href="#ch-' + index + '">' + item.label.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])) + "</a>")
        .join("");
      tocBox.classList.toggle("has-items", tocItems.length > 0);
    }

    const blobCache = {};
    async function rewrite(html, chapterPath) {
      const urls = [];
      html.replace(/(?:src|href)\s*=\s*["']([^"']+)["']/gi, (_, href) => {
        if (!/^(https?:|data:|blob:|#)/i.test(href)) urls.push(href);
        return _;
      });
      for (let i = 0; i < urls.length; i++) {
        const abs = resolveHref(chapterPath, urls[i]);
        if (!blobCache[abs]) {
          const lower = abs.toLowerCase();
          const mime = lower.endsWith(".css")
            ? "text/css"
            : lower.endsWith(".png")
              ? "image/png"
              : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
                ? "image/jpeg"
                : lower.endsWith(".gif")
                  ? "image/gif"
                  : lower.endsWith(".svg")
                    ? "image/svg+xml"
                    : "";
          blobCache[abs] = await blobUrl(zip, abs, mime);
        }
        if (blobCache[abs]) {
          html = html.split(urls[i]).join(blobCache[abs]);
        }
      }
      return html;
    }

    const chapters = [];
    for (let i = 0; i < spine.length; i++) {
      let html = await zipText(zip, spine[i]);
      html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
      const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, html])[1];
      chapters.push(await rewrite(body, spine[i]));
    }

    paper.innerHTML = chapters
      .map((html, index) => '<section id="ch-' + index + '">' + html + "</section>")
      .join("");

    const notes = await loadHighlights(path, title);
    wrapHighlights(paper, notes.map((item) => item.text));
  }

  if (tab) {
    const titleEl = tab.querySelector("span");
    if (titleEl) {
      titleEl.addEventListener("click", () => {
        if (tocBox && tocBox.classList.contains("has-items")) {
          tocBox.classList.toggle("is-open");
        }
      });
    }
  }
  if (tocBox) {
    tocBox.addEventListener("click", (event) => {
      const link = event.target.closest("a");
      if (!link) return;
      event.preventDefault();
      const target = document.querySelector(link.getAttribute("href"));
      if (target) target.scrollIntoView({ block: "start" });
      tocBox.classList.remove("is-open");
    });
  }

  const path = bookPath();
  if (!path) return;
  if (typeof JSZip === "undefined") {
    paper.innerHTML = '<div class="reader-empty">Unable to load the EPUB reader.</div>';
    return;
  }
  renderEpub(path).catch((error) => {
    paper.innerHTML = '<div class="reader-empty">' + String(error.message || error) + "</div>";
  });
})();

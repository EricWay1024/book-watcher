"""EPUB -> chapters -> paragraphs -> sentences.

The output is a plain dict (see `parse_epub`) that the web page consumes directly.
"""

import posixpath
import re
import warnings
import zipfile
from urllib.parse import unquote

from bs4 import BeautifulSoup, Comment, Doctype, NavigableString, ProcessingInstruction, Tag, XMLParsedAsHTMLWarning

warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

PARSER_VERSION = 3

BLOCK = {
    "address", "article", "aside", "blockquote", "body", "dd", "div", "dl", "dt",
    "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td",
    "tfoot", "th", "thead", "tr", "ul",
}
HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
HEADING_KINDS = HEADINGS | {"h7"}  # h7: a styled paragraph that acts as a heading (see _looks_like_heading)
SKIP = {"script", "style", "rt", "rp", "head", "title", "svg", "math", "img", "object", "iframe"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}

CJK = "⺀-⿟　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯"
_CJK_RE = re.compile(f"[{CJK}]")
_CJK_GAP = re.compile(f"(?<=[{CJK}]) (?=[{CJK}])")
_SELF_CLOSING = re.compile(rb"<([A-Za-z][\w:-]*)(\s[^<>]*?)?/>")

# Sentence end: CJK or Latin terminal punctuation, then any closing quotes/brackets.
_BOUND = re.compile(r"([。！？]+|[.!?]+)([”’」』）》】\"')\]]*)(\s*)")
_CLAUSE = re.compile(r"(?<=[，、；：,;:—])\s*")
ABBREV = {
    "mr", "mrs", "ms", "dr", "st", "prof", "sr", "jr", "vs", "etc", "e.g", "i.e",
    "no", "vol", "ch", "fig", "p", "pp", "cf", "mt", "gen", "col", "capt", "lt", "sgt",
}
MAX_WIDTH = 80  # display width units (one CJK char = 1) before a sentence is split at commas


def width(s: str) -> float:
    return sum(1 if _CJK_RE.match(c) else 0.55 for c in s)


def normalize(text: str) -> str:
    text = re.sub(r"\s+", " ", text.replace(" ", " ")).strip()
    return _CJK_GAP.sub("", text)


def split_sentences(text: str) -> list[str]:
    out, start = [], 0
    for m in _BOUND.finditer(text):
        nxt = text[m.end():m.end() + 1]
        if not nxt:
            break
        punct, ws = m.group(1), m.group(3)
        if punct[0] in ".!?":
            if not ws and not _CJK_RE.match(nxt):
                continue  # 3.14, U.S.A, "Hello!"he said
            if nxt.islower():
                continue
            if punct == ".":
                word = re.search(r"([\w.]+)$", text[start:m.start()])
                w = word.group(1).lower() if word else ""
                if w in ABBREV or (len(w) == 1 and w.isalpha()):
                    continue
        piece = text[start:m.end(2)].strip()
        if piece:
            out.append(piece)
        start = m.end()
    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return [c for s in out for c in _split_long(s)]


def _split_long(s: str) -> list[str]:
    """Break an over-long sentence into subtitle-sized chunks at clause punctuation."""
    if width(s) <= MAX_WIDTH:
        return [s]
    chunks, cur = [], ""
    for part in _CLAUSE.split(s):
        if cur and width(cur) + width(part) > MAX_WIDTH:
            chunks.append(cur)
            cur = ""
        cur = f"{cur} {part}" if cur and not _CJK_RE.match(part[:1]) and not _CJK_RE.match(cur[-1:]) else cur + part
    if cur:
        chunks.append(cur)
    return [h for c in chunks for h in _hard_split(c.strip())]


def _hard_split(s: str) -> list[str]:
    """Last resort for a clause with no punctuation: cut on spaces, or every N CJK chars."""
    if width(s) <= MAX_WIDTH * 1.25:
        return [s]
    if " " in s:
        out, cur = [], ""
        for word in s.split(" "):
            if cur and width(cur) + width(word) > MAX_WIDTH:
                out.append(cur)
                cur = word
            else:
                cur = f"{cur} {word}" if cur else word
        return out + ([cur] if cur else [])
    return [s[i:i + MAX_WIDTH] for i in range(0, len(s), MAX_WIDTH)]


# ---------------------------------------------------------------- HTML -> blocks


def _name(tag: Tag) -> str:
    return (tag.name or "").split(":")[-1].lower()


def _is_text(node) -> bool:
    return isinstance(node, NavigableString) and not isinstance(node, (Comment, Doctype, ProcessingInstruction))


def _has_block(tag: Tag) -> bool:
    return any(_name(d) in BLOCK for d in tag.find_all(True))


def _clean(soup: BeautifulSoup) -> None:
    for t in soup.find_all(True):
        if t.decomposed:
            continue
        n = _name(t)
        etype = " ".join(t.get(k, "") for k in ("epub:type", "role")).lower()
        if n in SKIP or "noteref" in etype or "footnote" in etype and n == "aside":
            t.decompose()
        elif n == "sup" and re.fullmatch(r"\s*[\[(]?[\d*†‡a-z]{1,3}[\])]?\s*", t.get_text()):
            t.decompose()
        elif n == "br":
            t.replace_with(" ")


def _is_bold(tag: Tag) -> bool:
    return (
        _name(tag) in ("b", "strong")
        or "bold" in " ".join(tag.get("class", [])).lower()
        or re.search(r"font-weight:\s*(bold|[6-9]00)", tag.get("style", "")) is not None
    )


def _looks_like_heading(tag: Tag, text: str) -> bool:
    """Converted books (e.g. Calibre from MOBI) often mark chapters as a short all-bold <p>."""
    if width(text) > 20 or re.search(r"[。！？.!?，,；;：:、]$", text):
        return False
    strings = [t for t in tag.find_all(string=True) if t.strip()]
    return bool(strings) and all(
        any(_is_bold(a) for a in [t.parent, *t.parent.parents] if a is not tag.parent and a in [tag, *tag.find_all(True)])
        for t in strings
    )


def _anchor_ids(tag: Tag) -> list[str]:
    """Ids (and old-style <a name>) on a tag and everything inside it: targets for TOC links."""
    ids = []
    for t in [tag, *tag.find_all(True)]:
        if t.get("id"):
            ids.append(t["id"])
        if _name(t) == "a" and t.get("name"):
            ids.append(t["name"])
    return ids


def _blocks(el: Tag, pending: list[str] | None = None) -> list[tuple[str, str, list[str]]]:
    """Flatten an element into (kind, text, anchor ids) paragraphs.

    `pending` collects ids of wrappers/empty elements; they attach to the next paragraph emitted.
    """
    out: list[tuple[str, str, list[str]]] = []
    buf: list[str] = []
    buf_ids: list[str] = []
    pending = [] if pending is None else pending

    def emit(kind, text, ids):
        out.append((kind, text, pending + ids))
        pending.clear()

    def flush():
        text = normalize("".join(buf))
        if text:
            emit("p", text, buf_ids[:])
        else:
            pending.extend(buf_ids)
        buf.clear()
        buf_ids.clear()

    for child in el.children:
        if _is_text(child):
            buf.append(str(child))
        elif isinstance(child, Tag):
            n = _name(child)
            nested = _has_block(child)
            if n in BLOCK or nested:
                flush()
                if nested:
                    if child.get("id"):
                        pending.append(child["id"])
                    out.extend(_blocks(child, pending))
                else:
                    text, ids = normalize(child.get_text()), _anchor_ids(child)
                    if text:
                        kind = n if n in HEADINGS else "h7" if _looks_like_heading(child, text) else "p"
                        emit(kind, text, ids)
                    else:
                        pending.extend(ids)
            else:
                buf.append(child.get_text())
                buf_ids.extend(_anchor_ids(child))
    flush()
    return out


def _soup(data: bytes) -> BeautifulSoup:
    # XHTML self-closing non-void tags (<a id="x"/>) would swallow following text in an HTML parser.
    def fix(m):
        tag = m.group(1)
        if tag.lower() in {v.encode() for v in VOID}:
            return m.group(0)
        return b"<" + tag + (m.group(2) or b"") + b"></" + tag + b">"

    return BeautifulSoup(_SELF_CLOSING.sub(fix, data), "lxml")


# ---------------------------------------------------------------- EPUB container


def _resolve(base: str, href: str) -> str:
    href = unquote(href.split("#", 1)[0])
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), href)) if href else ""


def _split_href(base: str, href: str) -> tuple[str, str]:
    frag = unquote(href.split("#", 1)[1]) if "#" in href else ""
    return _resolve(base, href), frag


def _toc(z: zipfile.ZipFile, manifest: dict, spine_toc: str | None) -> list[dict]:
    """The table of contents in reading order: [{title, path, frag, depth}]."""
    entries: list[dict] = []
    nav = next((it for it in manifest.values() if "nav" in it["props"]), None)
    if nav:
        soup = _soup(z.read(nav["path"]))
        navs = soup.find_all("nav")
        toc = next((n for n in navs if "toc" in (n.get("epub:type", "") + n.get("role", ""))), navs[0] if navs else None)
        for li in toc.find_all("li") if toc else []:
            label = next((c for c in li.children if isinstance(c, Tag) and _name(c) in ("a", "span")), None)
            link = label if label is not None and label.get("href") else li.find("a", href=True)
            if label is None or link is None:
                continue
            path, frag = _split_href(nav["path"], link["href"])
            title = normalize(label.get_text())
            if path and title:
                entries.append({"title": title, "path": path, "frag": frag, "depth": len(li.find_parents("li"))})
    if not entries and spine_toc and spine_toc in manifest:
        ncx_path = manifest[spine_toc]["path"]
        soup = BeautifulSoup(z.read(ncx_path), "lxml-xml")
        for point in soup.find_all("navPoint"):
            label, content = point.find("navLabel", recursive=False), point.find("content", recursive=False)
            if label and content and content.get("src"):
                path, frag = _split_href(ncx_path, content["src"])
                title = normalize(label.get_text())
                if path and title:
                    entries.append({"title": title, "path": path, "frag": frag, "depth": len(point.find_parents("navPoint"))})
    return entries


def _nest_headings(toc: list[dict], headings: list[dict]) -> list[dict]:
    """Slot the text's headings under the TOC entry each one falls in, ranked by heading level."""
    toc = sorted(toc, key=lambda o: o["p"])
    taken = {o["p"] for o in toc}
    extra = [h for h in headings if h["p"] not in taken]
    rank = {lvl: i for i, lvl in enumerate(sorted({h["depth"] for h in extra}))}
    out, j = [], 0
    for k, entry in enumerate([None, *toc]):
        if entry:
            out.append(entry)
        end = toc[k]["p"] if k < len(toc) else float("inf")
        base = entry["depth"] + 1 if entry else 0
        while j < len(extra) and extra[j]["p"] < end:
            out.append({**extra[j], "depth": base + rank[extra[j]["depth"]]})
            j += 1
    return out


def parse_epub(path: str) -> dict:
    with zipfile.ZipFile(path) as z:
        container = BeautifulSoup(z.read("META-INF/container.xml"), "lxml-xml")
        opf_path = container.find("rootfile")["full-path"]
        opf = BeautifulSoup(z.read(opf_path), "lxml-xml")

        def meta(name):
            t = opf.find(name)
            return normalize(t.get_text()) if t else ""

        manifest = {
            it["id"]: {
                "path": _resolve(opf_path, it["href"]),
                "type": it.get("media-type", ""),
                "props": it.get("properties", "").split(),
            }
            for it in opf.find("manifest").find_all("item")
            if it.get("id") and it.get("href")
        }
        spine = opf.find("spine")
        entries = _toc(z, manifest, spine.get("toc"))
        toc: dict[str, str] = {}
        for e in entries:
            toc.setdefault(e["path"], e["title"])
        names = set(z.namelist())

        chapters: list[dict] = []
        paras: list[dict] = []
        anchors: dict[tuple[str, str], int] = {}  # (document, id) -> paragraph; id "" = document start
        empty_docs: list[str] = []
        for ref in spine.find_all("itemref"):
            item = manifest.get(ref.get("idref"))
            if not item or ref.get("linear") == "no" or "nav" in item["props"] or item["path"] not in names:
                continue
            if "html" not in item["type"] and not item["path"].endswith((".html", ".xhtml", ".htm")):
                continue
            doc = item["path"]
            soup = _soup(z.read(doc))
            _clean(soup)
            body = soup.find("body") or soup
            blocks = _blocks(body)
            if not blocks:
                empty_docs.append(doc)  # e.g. a cover image page: links to it land on what follows
                continue
            for d in (*empty_docs, doc):
                anchors[(d, "")] = len(paras)
            empty_docs.clear()
            title = toc.get(doc)
            if title or not chapters or not toc:
                heading = next((t for k, t, _ in blocks if k in HEADING_KINDS), None)
                chapters.append({"title": title or heading or f"Section {len(chapters) + 1}", "p": len(paras)})
            carry: list[str] = []
            for kind, text, ids in blocks:
                sents = split_sentences(text)
                if not sents:
                    carry += ids
                    continue
                for i in (*carry, *ids):
                    anchors.setdefault((doc, i), len(paras))
                carry = []
                paras.append({"h": int(kind[1]), "s": sents} if kind in HEADING_KINDS else {"s": sents})

        outline = []
        for e in entries:
            p = anchors.get((e["path"], e["frag"]), anchors.get((e["path"], "")))
            if p is not None and p < len(paras):
                outline.append({"title": e["title"], "depth": e["depth"], "p": p})
        headings = [
            {"title": " ".join(p["s"])[:120], "depth": p["h"], "p": i} for i, p in enumerate(paras) if p.get("h")
        ]
        if len(outline) < 3 and len(headings) > len(outline):
            outline = headings  # TOC missing or useless (a single "Start" link): use the text's own headings
        elif len(outline) < 12 and len(headings) > len(outline):
            outline = _nest_headings(outline, headings)  # sparse TOC (e.g. only "Part 1..5"): add chapters
        if not outline:
            outline = [{"title": c["title"], "depth": 0, "p": c["p"]} for c in chapters]
        base = min(o["depth"] for o in outline)
        for o in outline:
            o["depth"] = min(o["depth"] - base, 4)

    return {
        "v": PARSER_VERSION,
        "title": meta("title") or posixpath.basename(path),
        "author": meta("creator"),
        "lang": meta("language"),
        "chapters": chapters,
        "outline": outline,
        "paras": paras,
        "sentences": sum(len(p["s"]) for p in paras),
    }

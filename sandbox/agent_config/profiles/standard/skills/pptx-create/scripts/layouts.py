"""Slide layouts for the pptx-create skill.

Each layout fills the content area and picks the largest font size at which its text fits. When
text cannot fit even at the smallest allowed size, the layout records a FIX issue instead of
letting it overflow, so build_deck.py can tell the agent which slide to shorten.
"""

import colorsys
import re
import zlib
from typing import NamedTuple

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

class Theme(NamedTuple):
    primary: str  # titles, callouts and table headers
    main: str  # the deck's colour
    second: str  # a contrasting colour that alternates with main
    cover: str  # "orbs", "panel" or "band"


# Slides stay white. Colours carry white text, and their tints carry dark text.
THEMES = {
    "blue": Theme("14213D", "1F6FEB", "D9480F", "orbs"),
    "teal": Theme("0F3D3E", "0F766E", "C2410C", "panel"),
    "green": Theme("1B4332", "2D6A4F", "B7791F", "band"),
    "indigo": Theme("1E1B4B", "4F46E5", "DB2777", "orbs"),
    "red": Theme("2B2D42", "C0392B", "1D4E89", "panel"),
    "amber": Theme("3D2C1E", "B45309", "0F766E", "band"),
    "plum": Theme("3B1F4A", "7E3A8A", "0E7490", "panel"),
}
# Colour words a user may ask for, as a theme name or a hex colour. Keys are lower case without
# spaces, hyphens or a trailing 色.
COLOR_WORDS = {
    "intel": "0068B5", "intelblue": "0068B5", "navy": "1F3A68", "purple": "6B21A8", "violet": "7C3AED",
    "orange": "EA580C", "yellow": "FACC15", "gold": "CA8A04", "pink": "DB2777", "magenta": "C026D3",
    "maroon": "7F1D1D", "brown": "8B5E34", "olive": "6B7A1F", "lime": "65A30D", "cyan": "0891B2",
    "turquoise": "0D9488", "black": "111827", "gray": "4B5563", "grey": "4B5563",
    "红": "red", "蓝": "blue", "绿": "green", "青": "teal", "紫": "6B21A8", "橙": "EA580C", "黄": "FACC15",
    "金": "CA8A04", "粉": "DB2777", "粉红": "DB2777", "棕": "8B5E34", "黑": "111827", "灰": "4B5563",
}
INK, MUTED, WHITE, GRAY = "1F2933", "52606D", "FFFFFF", "8A94A6"
TITLE_FONT, BODY_FONT, EA_FONT = "Segoe UI Semibold", "Segoe UI", "Microsoft YaHei"

W, H = Inches(13.333), Inches(7.5)
M = Inches(0.6)
TOP, BOTTOM = Inches(1.6), Inches(6.85)
GAP = Inches(0.3)
CW = W - 2 * M
# Text that misses a layout's floor size may shrink this many more points, never below MIN_SIZE,
# with a warning instead of a FIX, so a slightly long slide does not cost the agent a rebuild.
SHRINK, MIN_SIZE = 3, 10


class LayoutError(ValueError):
    """The slide's fields do not match the layout."""


def _rgb(hex_color: str) -> RGBColor:
    return RGBColor.from_string(hex_color)


def _tint(hex_color: str, keep: float = 0.16) -> RGBColor:
    rgb = [int(hex_color[i:i + 2], 16) for i in (0, 2, 4)]
    return RGBColor(*[round(255 - (255 - v) * keep) for v in rgb])


def _hls(hex_color: str) -> tuple[float, float, float]:
    return colorsys.rgb_to_hls(*[int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def _from_hls(h: float, l: float, s: float) -> str:
    return "".join(f"{round(v * 255):02X}" for v in colorsys.hls_to_rgb(h, l, s))


def _luminance(hex_color: str) -> float:
    def channel(v: int) -> float:
        c = v / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(int(hex_color[i:i + 2], 16)) for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _readable(hex_color: str) -> str:
    """The colour, darkened only as far as white bold text on it needs (contrast 3:1)."""
    h, l, s = _hls(hex_color)
    while _luminance(hex_color) > 0.3 and l > 0:
        l = max(0.0, l - 0.02)
        hex_color = _from_hls(h, l, s)
    return hex_color


def custom_theme(hex_color: str) -> Theme:
    """A theme around a colour the user asked for: same-hue dark titles and the opposite hue as second."""
    h, l, s = _hls(hex_color)
    main = _readable(hex_color)
    second = "D9480F" if s < 0.15 else _readable(_from_hls((h + 0.5) % 1, max(l, 0.45), min(max(s, 0.5), 0.8)))
    cover = ("orbs", "panel", "band")[zlib.crc32(hex_color.encode()) % 3]
    return Theme(_from_hls(h, 0.16, min(s, 0.5)), main, second, cover)


def resolve_theme(value: str) -> tuple[str, Theme] | None:
    """(label, theme) for a theme name, colour word or hex colour; None if it is none of those."""
    key = re.sub(r"[\s_\-]|色$", "", value.strip().lower())
    key = COLOR_WORDS.get(key, key)
    if key in THEMES:
        return key, THEMES[key]
    if re.fullmatch(r"#?[0-9a-f]{6}", key, re.I):
        code = key.lstrip("#").upper()
        return f"#{code}", custom_theme(code)
    return None


def _em(ch: str) -> float:
    """Approximate advance width of one character in ems."""
    if ord(ch) >= 0x2E80:
        return 1.0
    if ch in " il.,;:'|!()[]":
        return 0.3
    if ch in "mwMW@%":
        return 0.86
    if ch.isupper() or ch.isdigit():
        return 0.62
    return 0.52


def _lines(text: str, width: int, size: float, bold: bool) -> int:
    """Estimated wrapped line count of one paragraph in a box `width` EMU wide."""
    limit = width / Pt(1)
    if limit <= 0:
        raise LayoutError("a text box has no width left; use fewer columns or shorter text")
    scale = size * (1.06 if bold else 1.0)
    lines, current = 1, 0.0
    for token in re.findall(r"[\u2e80-\uffff]|[^\s\u2e80-\uffff]+\s*|\s+", text):
        token_w = sum(_em(c) for c in token) * scale
        if current + token_w > limit and current > 0:
            lines += 1
            current = sum(_em(c) for c in token.lstrip()) * scale
        else:
            current += token_w
        while current > limit:
            lines += 1
            current -= limit
    return lines


def _height(paras: list[str], width: int, size: float, bold: bool, bullets: bool) -> int:
    indent = Pt(size * 0.95) if bullets else 0
    lines = sum(_lines(p, width - indent, size, bold) for p in paras)
    return int(Pt(size) * (1.2 * lines + 0.45 * (len(paras) - 1)))


def _as_list(value: object) -> list[str]:
    return [str(v) for v in value] if isinstance(value, list) else [str(value)]


def _label(title: str, english: str, chinese: str) -> str:
    """Default panel heading in the slide's language."""
    return chinese if re.search(r"[\u2e80-\uffff]", title) else english


def _badge_ok(badge: str, cjk_ok: bool) -> bool:
    return len(badge) <= 2 and all((c.isascii() and c.isalnum()) or (cjk_ok and "\u2e80" <= c <= "\u9fff")
                                   for c in badge)


def words(value: object) -> int:
    """Words in a field, counting two CJK characters as one word."""
    if isinstance(value, list):
        return sum(words(v) for v in value)
    if isinstance(value, dict):
        return sum(words(v) for v in value.values())
    text = str(value)
    cjk = len(re.findall(r"[\u2e80-\uffff]", text))
    return len(re.findall(r"[^\s\u2e80-\uffff]+", text)) + cjk // 2


class Deck:
    def __init__(self, theme: Theme) -> None:
        self.primary, main, second, self.cover_style = theme
        self.accents = [main, second]
        self.series = [main, second, self.primary, GRAY]  # chart colours
        self.prs = Presentation()
        self.prs.slide_width, self.prs.slide_height = W, H
        self.issues: list[str] = []
        self.warnings: list[str] = []
        self.number = 0
        self.layout = ""
        # 1 on every second use of a layout, so repeated layouts lead with the other colour.
        self.variant = 0

    def accent(self, i: int) -> str:
        return self.accents[(i + self.variant) % len(self.accents)]

    # ---- primitives -------------------------------------------------------------------------

    def fit(self, groups: list[tuple[object, int, int]], start: int, floor: int, bold: bool = False,
            bullets: bool = False, what: str = "text") -> int:
        """Largest size from start down to floor at which every (text, width, height) box fits.

        All boxes in a group share one size so peers look alike. Below floor the size may drop
        SHRINK more points with a warning; past that it records a FIX naming the longest text.
        """
        lowest = max(floor - SHRINK, MIN_SIZE)
        for size in range(start, lowest - 1, -1):
            if all(_height(_as_list(t), w, size, bold, bullets) <= h for t, w, h in groups):
                if size < floor:
                    self.warnings.append(f"slide {self.number} ({self.layout}): {what} was set at {size}pt "
                                         "to fit; optional, shorten it to make it larger")
                return size
        # The word target is for floor, so one cut leaves the shrink range as margin.
        ratio, text = max(((_height(_as_list(t), w, floor, bold, bullets) / h, t) for t, w, h in groups),
                          key=lambda pair: pair[0])
        plain = " ".join(_as_list(text))
        start_of = " ".join(plain.split()[:6]) if " " in plain else plain[:12]
        count = words(text)
        self.issues.append(f"slide {self.number} ({self.layout}): {what} starting \"{start_of}\" is too long; "
                           f"cut it from about {count} to {int(count / ratio)} words, or split the slide")
        return lowest

    def box(self, slide, x: int, y: int, w: int, h: int, fill: RGBColor | None,
            shape: MSO_SHAPE = MSO_SHAPE.RECTANGLE):
        s = slide.shapes.add_shape(shape, int(x), int(y), int(w), int(h))
        s.line.fill.background()
        s.shadow.inherit = False
        if fill is None:
            s.fill.background()
        else:
            s.fill.solid()
            s.fill.fore_color.rgb = fill
        return s

    def text(self, slide, x: int, y: int, w: int, h: int, paras: object, size: float,
             color: str = INK, bold: bool = False, font: str = BODY_FONT,
             align: PP_ALIGN = PP_ALIGN.LEFT, anchor: MSO_ANCHOR = MSO_ANCHOR.TOP,
             bullets: bool = False, bullet_color: str | None = None):
        tb = slide.shapes.add_textbox(int(x), int(y), int(w), int(h))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        tf.vertical_anchor = anchor
        for i, line in enumerate(_as_list(paras)):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.alignment = align
            p.line_spacing = 1.0
            if i:
                p.space_before = Pt(size * 0.45)
            if bullets:
                ppr = p._p.get_or_add_pPr()
                ppr.set("marL", str(int(Pt(size * 0.95))))
                ppr.set("indent", str(-int(Pt(size * 0.95))))
                clr = ppr.makeelement(qn("a:buClr"), {})
                clr.append(clr.makeelement(qn("a:srgbClr"), {"val": bullet_color or self.accent(0)}))
                ppr.append(clr)
                ppr.append(ppr.makeelement(qn("a:buChar"), {"char": "\u25cf"}))
            r = p.add_run()
            r.text = line
            r.font.size, r.font.bold, r.font.name = Pt(size), bold, font
            r.font.color.rgb = _rgb(color)
            rpr = r._r.get_or_add_rPr()
            rpr.append(rpr.makeelement(qn("a:ea"), {"typeface": EA_FONT}))
        return tb

    def badge(self, slide, x: int, y: int, d: int, label: str, color: str,
              shape: MSO_SHAPE = MSO_SHAPE.OVAL) -> None:
        self.box(slide, x, y, d, d, _rgb(color), shape)
        self.text(slide, x, y, d, d, label, 18 if len(label) < 3 else 13, WHITE, True, TITLE_FONT,
                  PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)

    def new_slide(self):
        return self.prs.slides.add_slide(self.prs.slide_layouts[6])

    def content_slide(self, title: str, source: str | None):
        slide = self.new_slide()
        self.box(slide, 0, 0, Inches(0.16), H, _rgb(self.accent(0)))
        size = self.fit([(title, CW, Inches(1.05))], 32, 24, bold=True, what="the title")
        self.text(slide, M, Inches(0.35), CW, Inches(1.05), title, size, self.primary, True, TITLE_FONT,
                  anchor=MSO_ANCHOR.MIDDLE)
        if source:
            self.text(slide, M, Inches(7.0), CW - Inches(1.2), Inches(0.3), source, 11, MUTED)
        self.text(slide, W - M - Inches(1), Inches(7.0), Inches(1), Inches(0.3), str(self.number), 11,
                  MUTED, align=PP_ALIGN.RIGHT)
        return slide

    def callout(self, slide, y: int, h: int, message: str) -> None:
        self.box(slide, M, y, CW, h, _rgb(self.primary))
        size = self.fit([(message, CW - Inches(0.7), h - Inches(0.2))], 20, 14, bold=True, what="the callout")
        self.text(slide, M + Inches(0.35), y, CW - Inches(0.7), h, message, size, WHITE, True,
                  anchor=MSO_ANCHOR.MIDDLE)

    def panel_list(self, slide, x: int, y: int, w: int, h: int, heading: str, items: list[str],
                   color: str, size: int | None = None) -> None:
        """Tinted panel with a coloured heading band and a bullet list."""
        band = Inches(0.7)
        self.box(slide, x, y, w, band, _rgb(color))
        self.text(slide, x + Inches(0.3), y, w - Inches(0.6), band, heading, 20, WHITE, True, TITLE_FONT,
                  anchor=MSO_ANCHOR.MIDDLE)
        self.box(slide, x, y + band, w, h - band, _tint(color))
        self.text(slide, x + Inches(0.3), y + band + Inches(0.25), w - Inches(0.6), h - band - Inches(0.45),
                  items, size or 18, INK, bullets=True, bullet_color=color)

    # ---- layouts ----------------------------------------------------------------------------

    def cover(self, title: str, subtitle: str = "", note: str = "") -> None:
        slide = self.new_slide()
        main, second = _rgb(self.accent(0)), _rgb(self.accent(1))
        # Every shape stays inside the slide and clear of the title and subtitle, which end at M + width.
        width = Inches(8.4)
        if self.cover_style == "orbs":
            self.box(slide, Inches(9.5), Inches(0.9), Inches(3.2), Inches(3.2), main, MSO_SHAPE.OVAL)
            self.box(slide, Inches(10.9), Inches(3.75), Inches(1.8), Inches(1.8), second, MSO_SHAPE.OVAL)
        elif self.cover_style == "panel":
            self.box(slide, Inches(9.6), 0, W - Inches(9.6), H, main)
            self.box(slide, Inches(9.6), 0, Inches(0.14), H, second)
        else:
            width = CW
            self.box(slide, 0, 0, W, Inches(0.45), main)
            self.box(slide, 0, Inches(0.45), W, Inches(0.08), second)
        # Below the title's descenders, which reach past the bottom of its box.
        self.box(slide, M, Inches(3.8), Inches(1.2), Inches(0.07), second)
        self.box(slide, M, Inches(6.35), width, Pt(0.75), _rgb(GRAY))
        size = self.fit([(title, width, Inches(2.2))], 54, 36, bold=True, what="the title")
        self.text(slide, M, Inches(1.4), width, Inches(2.2), title, size, self.primary, True, TITLE_FONT,
                  anchor=MSO_ANCHOR.BOTTOM)
        if subtitle:
            size = self.fit([(subtitle, width, Inches(1.4))], 24, 16, what="the subtitle")
            self.text(slide, M, Inches(4.0), width, Inches(1.4), subtitle, size, MUTED)
        if note:
            self.text(slide, M, Inches(6.5), width, Inches(0.6), note, 16, MUTED, anchor=MSO_ANCHOR.MIDDLE)

    def section(self, title: str, number: str = "", subtitle: str = "") -> None:
        slide = self.new_slide()
        self.box(slide, 0, 0, Inches(0.12), H, _rgb(self.accent(0)))
        if number:
            self.text(slide, M + Inches(0.3), Inches(1.6), Inches(4), Inches(1.6), number, 88,
                      self.accent(1), True, TITLE_FONT, anchor=MSO_ANCHOR.BOTTOM)
        size = self.fit([(title, Inches(11), Inches(1.6))], 44, 30, bold=True, what="the title")
        self.text(slide, M + Inches(0.3), Inches(3.3), Inches(11), Inches(1.6), title, size, self.primary, True,
                  TITLE_FONT)
        if subtitle:
            self.text(slide, M + Inches(0.3), Inches(4.9), Inches(11), Inches(1.2), subtitle, 22, MUTED)

    def cards(self, title: str, cards: list, columns: int | None = None, callout: str = "",
              source: str = "") -> None:
        if not 2 <= len(cards) <= 6:
            raise LayoutError("cards needs 2 to 6 cards")
        parsed = []
        for card in cards:
            if not isinstance(card, list) or len(card) not in (2, 3):
                raise LayoutError("each card is [heading, text] or [badge, heading, text]")
            parsed.append(card if len(card) == 3 else ["", *card])
        # Models use badges as icons and reach for emoji, symbols or other-language characters.
        cjk_ok = bool(re.search(r"[\u2e80-\uffff]", title))
        if not all(_badge_ok(str(b), cjk_ok) for b, _, _ in parsed):
            parsed = [[str(i + 1), h, t] for i, (_, h, t) in enumerate(parsed)]
            self.warnings.append(f"slide {self.number} (cards): badges are 1-2 letters or digits, "
                                 "so the cards were numbered")
        slide = self.content_slide(title, source)
        cols = columns or {2: 2, 3: 3, 4: 2, 5: 3, 6: 3}[len(parsed)]
        rows = -(-len(parsed) // cols)
        bottom = BOTTOM - (Inches(1.05) if callout else 0)
        cw = (CW - GAP * (cols - 1)) // cols
        ch = (bottom - TOP - GAP * (rows - 1)) // rows
        pad, head_h = Inches(0.3), Inches(0.65)
        has_badge = any(b for b, _, _ in parsed)
        head_w = cw - 2 * pad - (Inches(0.8) if has_badge else 0)
        head_size = self.fit([(h, head_w, head_h) for _, h, _ in parsed], 22, 15, bold=True, what="a card heading")
        body_y = Inches(0.25) + head_h + Inches(0.12)
        body_size = self.fit([(t, cw - 2 * pad, ch - body_y - Inches(0.2)) for _, _, t in parsed], 20, 13,
                             what="card text")
        for i, (badge, heading, body) in enumerate(parsed):
            color = self.accent(i)
            x, y = M + (cw + GAP) * (i % cols), TOP + (ch + GAP) * (i // cols)
            self.box(slide, x, y, cw, ch, _tint(color))
            if self.variant:
                self.box(slide, x, y, Inches(0.08), ch, _rgb(color))
            else:
                self.box(slide, x, y, cw, Inches(0.08), _rgb(color))
            hx = x + pad
            if has_badge:
                self.badge(slide, hx, y + Inches(0.275), Inches(0.6), str(badge), color,
                           MSO_SHAPE.ROUNDED_RECTANGLE if self.variant else MSO_SHAPE.OVAL)
                hx += Inches(0.8)
            self.text(slide, hx, y + Inches(0.25), head_w, head_h, heading, head_size, INK, True, TITLE_FONT,
                      anchor=MSO_ANCHOR.MIDDLE)
            self.text(slide, x + pad, y + body_y, cw - 2 * pad, ch - body_y - Inches(0.2), body, body_size, INK)
        if callout:
            self.callout(slide, bottom + Inches(0.3), Inches(0.75), callout)

    def stats(self, title: str, stats: list, columns: list | None = None, bullets: list | None = None,
              source: str = "") -> None:
        if not 2 <= len(stats) <= 4 or any(not isinstance(s, list) or len(s) not in (2, 3) for s in stats):
            raise LayoutError("stats needs 2 to 4 items of [value, label] or [value, label, note]")
        if columns and (len(columns) > 2 or any(len(c) != 2 for c in columns)):
            raise LayoutError("columns is up to 2 items of [heading, [bullets]]")
        slide = self.content_slide(title, source)
        lower = columns or bullets
        card_h = Inches(2.6) if lower else BOTTOM - TOP
        cw = (CW - GAP * (len(stats) - 1)) // len(stats)
        pad = Inches(0.3)
        value_size = self.fit([(s[0], cw - 2 * pad, Inches(1.1)) for s in stats], 60, 32, bold=True,
                              what="a stat value")
        label_size = self.fit([(s[1], cw - 2 * pad, Inches(0.45)) for s in stats], 20, 14, bold=True,
                              what="a stat label")
        note_h = card_h - Inches(1.75) - Inches(0.2)
        notes = [s[2] for s in stats if len(s) == 3]
        note_size = self.fit([(n, cw - 2 * pad, note_h) for n in notes], 18 if lower else 20, 12,
                             what="a stat note") if notes else 14
        for i, stat in enumerate(stats):
            color = self.accent(i)
            x = M + (cw + GAP) * i
            self.box(slide, x, TOP, cw, card_h, _tint(color))
            self.box(slide, x, TOP, Inches(0.08), card_h, _rgb(color))
            self.text(slide, x + pad, TOP + Inches(0.1), cw - 2 * pad, Inches(1.1), stat[0], value_size, color,
                      True, TITLE_FONT, anchor=MSO_ANCHOR.BOTTOM)
            self.text(slide, x + pad, TOP + Inches(1.25), cw - 2 * pad, Inches(0.45), stat[1], label_size, INK, True)
            if len(stat) == 3:
                self.text(slide, x + pad, TOP + Inches(1.75), cw - 2 * pad, note_h, stat[2], note_size, MUTED)
        if not lower:
            return
        y = TOP + card_h + Inches(0.35)
        if columns:
            colw = (CW - GAP) // len(columns)
            size = self.fit([(c[1], colw, BOTTOM - y - Inches(0.55)) for c in columns], 20, 13, bullets=True,
                            what="the bullet text")
            for i, (heading, items) in enumerate(columns):
                x = M + (colw + GAP) * i
                self.text(slide, x, y, colw, Inches(0.5), heading, 20, self.primary, True, TITLE_FONT)
                self.text(slide, x, y + Inches(0.55), colw, BOTTOM - y - Inches(0.55), items, size, INK,
                          bullets=True, bullet_color=self.accent(i))
        else:
            size = self.fit([(bullets, CW, BOTTOM - y)], 20, 13, bullets=True, what="the bullet text")
            self.text(slide, M, y, CW, BOTTOM - y, bullets, size, INK, bullets=True)

    def two_column(self, title: str, columns: list, callout: str = "", source: str = "") -> None:
        if len(columns) != 2 or any(not isinstance(c, list) or len(c) != 2 or not isinstance(c[1], list)
                                    for c in columns):
            raise LayoutError("columns is exactly 2 items of [heading, [bullets]]")
        slide = self.content_slide(title, source)
        bottom = BOTTOM - (Inches(1.05) if callout else 0)
        colw = (CW - GAP) // 2
        size = self.fit([(c[1], colw - Inches(0.6), bottom - TOP - Inches(1.15)) for c in columns], 20, 13,
                        bullets=True, what="the bullet text")
        for i, (heading, items) in enumerate(columns):
            self.panel_list(slide, M + (colw + GAP) * i, TOP, colw, bottom - TOP, heading, items, self.accent(i),
                            size)
        if callout:
            self.callout(slide, bottom + Inches(0.3), Inches(0.75), callout)

    def table(self, title: str, headers: list, rows: list, insights: list | None = None,
              insight_title: str = "", source: str = "") -> None:
        cols = len(headers)
        if not 2 <= cols <= 6 or not 1 <= len(rows) <= 8 or any(len(r) != cols for r in rows):
            raise LayoutError("table needs 2-6 headers and 1-8 rows, each with one cell per header")
        slide = self.content_slide(title, source)
        panel_w = Inches(3.7) if insights else 0
        tw = CW - (panel_w + GAP if insights else 0)
        cell_pad = Inches(0.24)
        cells = [[str(r[c]) for r in [headers, *rows]] for c in range(cols)]
        # Every column fits its longest word (CJK text counts in words of up to 4 characters) at 16pt bold;
        # spare width follows each column's text length. If even those words do not fit, columns whose
        # words fit an equal share keep them and the rest share what is left.
        longest = [max(sum(_em(ch) for ch in word) * Pt(17) for cell in col
                       for word in re.findall(r"[\u2e80-\uffff]{1,4}|[^\s\u2e80-\uffff]+", cell) or [""])
                   for col in cells]
        room = tw - cols * cell_pad
        if sum(longest) > room:
            share = room / cols
            kept = sum(n for n in longest if n <= share)
            wide = sum(n for n in longest if n > share)
            longest = [n if n <= share else n * (room - kept) / wide for n in longest]
        floors = [n + cell_pad for n in longest]
        lengths = [max(len(cell) for cell in col) for col in cells]
        spare_w = max(0, tw - sum(floors))
        widths = [int(f + spare_w * n / sum(lengths)) for f, n in zip(floors, lengths)]
        widths[-1] += tw - sum(widths)
        size = 18
        for size in range(18, 10, -1):
            heights = [max(_height([str(cell)], w - cell_pad, size, i == 0, False) for cell, w in zip(row, widths))
                       + Inches(0.22) for i, row in enumerate([headers, *rows])]
            if sum(heights) <= BOTTOM - TOP:
                break
        else:
            self.issues.append(f"slide {self.number} (table): the table is too long; use fewer rows or "
                               "shorter cells, or split it")
        spare = (BOTTOM - TOP - sum(heights)) // (len(rows) + 1)
        shape = slide.shapes.add_table(len(rows) + 1, cols, M, TOP, tw, sum(heights))
        table = shape.table
        table.first_row = True
        shape._element.graphic.graphicData.tbl.tblPr.set("bandRow", "0")
        for c, w in enumerate(widths):
            table.columns[c].width = w
        for r, row in enumerate([headers, *rows]):
            table.rows[r].height = int(heights[r] + min(spare, Inches(0.35)))
            for c, value in enumerate(row):
                cell = table.cell(r, c)
                cell.fill.solid()
                cell.fill.fore_color.rgb = (_rgb(self.primary) if r == 0
                                            else _tint(self.accent(0), 0.1) if r % 2 == 0 else _rgb(WHITE))
                cell.margin_left = cell.margin_right = Inches(0.12)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                tf = cell.text_frame
                tf.word_wrap = True
                tf.paragraphs[0].text = ""
                run = tf.paragraphs[0].add_run()
                run.text = str(value)
                run.font.size = Pt(size)
                run.font.bold = r == 0 or c == 0
                run.font.name = TITLE_FONT if r == 0 or c == 0 else BODY_FONT
                run.font.color.rgb = _rgb(WHITE if r == 0 else INK)
        if insights:
            x = M + tw + GAP
            ph = BOTTOM - TOP
            isize = self.fit([(insights, panel_w - Inches(0.6), ph - Inches(1.15))], 18, 12, bullets=True,
                             what="the insights")
            heading = insight_title or _label(title, "What this means", "启示")
            self.panel_list(slide, x, TOP, panel_w, ph, heading, insights, self.accent(1), isize)

    def numbered(self, title: str, items: list, panel: dict | None = None, source: str = "") -> None:
        if not 2 <= len(items) <= 5 or any(not isinstance(i, list) or len(i) != 2 for i in items):
            raise LayoutError("items is 2 to 5 entries of [heading, text]")
        slide = self.content_slide(title, source)
        panel_w = Inches(3.9) if panel else 0
        lw = CW - (panel_w + Inches(0.4) if panel else 0)
        row_h = (BOTTOM - TOP) // len(items)
        text_w = lw - Inches(0.95)
        head_size = self.fit([(h, text_w, Inches(0.5)) for h, _ in items], 22, 16, bold=True, what="an item heading")
        body_size = self.fit([(t, text_w, row_h - Inches(0.75)) for _, t in items], 18, 12, what="item text")
        for i, (heading, body) in enumerate(items):
            y = TOP + row_h * i
            self.badge(slide, M, y + Inches(0.1), Inches(0.6), str(i + 1), self.accent(i))
            self.text(slide, M + Inches(0.95), y + Inches(0.05), text_w, Inches(0.55), heading, head_size, INK, True,
                      TITLE_FONT, anchor=MSO_ANCHOR.MIDDLE)
            self.text(slide, M + Inches(0.95), y + Inches(0.65), text_w, row_h - Inches(0.75), body, body_size, MUTED)
            if i < len(items) - 1:
                self.box(slide, M + Inches(0.95), y + row_h - Inches(0.06), text_w, Pt(1), _tint(self.accent(0), 0.4))
        if panel:
            if not isinstance(panel, dict):
                raise LayoutError('panel is {"value": ..., "label": ..., "text": ...}')
            x, pw, pad = M + lw + Inches(0.4), panel_w, Inches(0.35)
            self.box(slide, x, TOP, pw, BOTTOM - TOP, _tint(self.accent(0)))
            self.box(slide, x, TOP, pw, Inches(0.08), _rgb(self.accent(1)))
            y = TOP + Inches(0.4)
            if panel.get("value"):
                vsize = self.fit([(panel["value"], pw - 2 * pad, Inches(1.3))], 60, 32, bold=True, what="the panel value")
                self.text(slide, x + pad, y, pw - 2 * pad, Inches(1.3), panel["value"], vsize, self.accent(0), True,
                          TITLE_FONT, anchor=MSO_ANCHOR.BOTTOM)
                y += Inches(1.4)
            if panel.get("label"):
                self.text(slide, x + pad, y, pw - 2 * pad, Inches(0.8), panel["label"], 18, self.primary, True)
                y += Inches(0.9)
            if panel.get("text"):
                tsize = self.fit([(panel["text"], pw - 2 * pad, BOTTOM - y - pad)], 17, 12, what="the panel text")
                self.text(slide, x + pad, y, pw - 2 * pad, BOTTOM - y - pad, panel["text"], tsize, MUTED)

    def steps(self, title: str, steps: list, callout: str = "", source: str = "") -> None:
        if not 3 <= len(steps) <= 6 or any(not isinstance(s, list) or len(s) != 2 for s in steps):
            raise LayoutError("steps is 3 to 6 entries of [heading, text]")
        slide = self.content_slide(title, source)
        bottom = BOTTOM - (Inches(1.05) if callout else 0)
        n = len(steps)
        overlap = Inches(0.12)
        sw = (CW + overlap * (n - 1)) // n
        arrow_h = Inches(0.95)
        head_size = self.fit([(h, sw - Inches(0.95), arrow_h - Inches(0.1)) for h, _ in steps], 20, 13, bold=True,
                             what="a step heading")
        body_h = bottom - TOP - arrow_h - Inches(0.25)
        cw = sw - overlap - Inches(0.1)
        body_size = self.fit([(t, cw - Inches(0.5), body_h - Inches(0.5)) for _, t in steps], 19, 12,
                             what="step text")
        for i, (heading, body) in enumerate(steps):
            color = self.accent(i)
            x = M + (sw - overlap) * i
            shape = MSO_SHAPE.PENTAGON if i == 0 else MSO_SHAPE.CHEVRON
            self.box(slide, x, TOP, sw, arrow_h, _rgb(color), shape)
            self.text(slide, x + Inches(0.45 if i else 0.25), TOP, sw - Inches(0.95), arrow_h,
                      f"{i + 1}  {heading}", head_size, WHITE, True, TITLE_FONT, anchor=MSO_ANCHOR.MIDDLE)
            by = TOP + arrow_h + Inches(0.25)
            self.box(slide, x, by, cw, body_h, _tint(color))
            self.text(slide, x + Inches(0.25), by + Inches(0.25), cw - Inches(0.5), body_h - Inches(0.5), body,
                      body_size, INK)
        if callout:
            self.callout(slide, bottom + Inches(0.3), Inches(0.75), callout)

    def chart(self, title: str, kind: str, categories: list, series: list, takeaways: list | None = None,
              takeaways_title: str = "", number_format: str = "General", source: str = "") -> None:
        kinds = {"bar": XL_CHART_TYPE.BAR_CLUSTERED, "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
                 "stacked": XL_CHART_TYPE.COLUMN_STACKED, "line": XL_CHART_TYPE.LINE_MARKERS,
                 "donut": XL_CHART_TYPE.DOUGHNUT}
        if kind not in kinds:
            raise LayoutError(f"kind is one of: {', '.join(kinds)}")
        if not series or any(not isinstance(s, list) or len(s) != 2 or len(s[1]) != len(categories) for s in series):
            raise LayoutError("series is a list of [name, [one number per category]]")
        if kind == "donut" and len(series) != 1:
            raise LayoutError("a donut chart takes exactly one series")
        slide = self.content_slide(title, source)
        panel_w = Inches(4.0) if takeaways else 0
        chart_w = CW - (panel_w + GAP if takeaways else 0)
        order = slice(None, None, -1) if kind == "bar" else slice(None)  # bars draw bottom-up
        data = CategoryChartData(number_format=number_format)
        data.categories = [str(c) for c in categories][order]
        for name, values in series:
            data.add_series(str(name), [float(v) for v in values][order])
        chart = slide.shapes.add_chart(kinds[kind], M, TOP, chart_w, BOTTOM - TOP, data).chart
        chart.has_title = False
        chart.font.size, chart.font.name = Pt(15), BODY_FONT
        chart.font.color.rgb = _rgb(INK)
        multi = len(series) > 1 or kind == "donut"
        chart.has_legend = multi
        if multi:
            chart.legend.position = XL_LEGEND_POSITION.BOTTOM
            chart.legend.include_in_layout = False
            chart.legend.font.size = Pt(15)
        plot = chart.plots[0]

        def color(i: int) -> RGBColor:
            return _rgb(self.series[i % len(self.series)])

        if kind == "donut":
            for i, point in enumerate(plot.series[0].points):
                point.format.fill.solid()
                point.format.fill.fore_color.rgb = color(i)
        else:
            for i, s in enumerate(plot.series):
                fmt = s.format
                if kind == "line":
                    fmt.line.color.rgb = color(i)
                    fmt.line.width = Pt(3.5)
                    s.marker.format.fill.solid()
                    s.marker.format.fill.fore_color.rgb = color(i)
                else:
                    fmt.fill.solid()
                    fmt.fill.fore_color.rgb = color(i)
            if kind != "line":
                plot.gap_width = 60
            value_axis = chart.value_axis
            value_axis.has_major_gridlines = True
            value_axis.major_gridlines.format.line.color.rgb = _tint(MUTED, 0.25)
            value_axis.format.line.fill.background()
            value_axis.tick_labels.font.color.rgb = _rgb(MUTED)
            chart.category_axis.format.line.color.rgb = _tint(MUTED, 0.5)
        if kind != "line" and kind != "stacked":
            plot.has_data_labels = True
            labels = plot.data_labels
            labels.font.size, labels.font.bold = Pt(14), True
            labels.number_format, labels.number_format_is_linked = number_format, False
            if kind == "donut":
                labels.font.color.rgb = _rgb(WHITE)
            else:
                labels.position = XL_LABEL_POSITION.OUTSIDE_END
        if takeaways:
            size = self.fit([(takeaways, panel_w - Inches(0.6), BOTTOM - TOP - Inches(1.15))], 19, 12, bullets=True,
                            what="the takeaways")
            heading = takeaways_title or _label(title, "Key takeaways", "要点")
            self.panel_list(slide, M + chart_w + GAP, TOP, panel_w, BOTTOM - TOP, heading, takeaways,
                            self.accent(1), size)

    def quote(self, quote: str, attribution: str = "", source: str = "") -> None:
        slide = self.new_slide()
        self.box(slide, M, Inches(1.3), Inches(0.14), Inches(4.6), _rgb(self.accent(1)))
        self.text(slide, M + Inches(0.5), Inches(0.5), Inches(2), Inches(1.4), "\u201c", 120, self.accent(0), True,
                  TITLE_FONT)
        width = CW - Inches(1.2)
        size = self.fit([(quote, width, Inches(3.4))], 36, 22, bold=True, what="the quote")
        self.text(slide, M + Inches(0.6), Inches(1.7), width, Inches(3.4), quote, size, self.primary, True, TITLE_FONT,
                  anchor=MSO_ANCHOR.MIDDLE)
        if attribution:
            self.text(slide, M + Inches(0.6), Inches(5.3), width, Inches(0.6), attribution, 20, MUTED)
        if source:
            self.text(slide, M, Inches(7.0), CW, Inches(0.3), source, 11, MUTED)

    def closing(self, title: str, bullets: list | None = None, next_step: str = "", message: str = "") -> None:
        slide = self.new_slide()
        self.box(slide, 0, 0, Inches(0.12), H, _rgb(self.accent(0)))
        size = self.fit([(title, CW, Inches(1.2))], 40, 28, bold=True, what="the title")
        self.text(slide, M + Inches(0.2), Inches(0.6), CW, Inches(1.2), title, size, self.primary, True, TITLE_FONT,
                  anchor=MSO_ANCHOR.MIDDLE)
        bottom = Inches(5.0) if next_step else Inches(6.6)
        body = bullets or ([message] if message else [])
        if body:
            bsize = self.fit([(body, CW - Inches(0.2), bottom - Inches(2.1))], 22, 14, bullets=bool(bullets),
                             what="the closing text")
            self.text(slide, M + Inches(0.2), Inches(2.1), CW - Inches(0.2), bottom - Inches(2.1), body, bsize,
                      INK, bullets=bool(bullets), bullet_color=self.accent(1))
        if next_step:
            self.box(slide, M + Inches(0.2), Inches(5.3), CW - Inches(0.2), Inches(1.4), _rgb(self.accent(0)))
            nsize = self.fit([(next_step, CW - Inches(0.9), Inches(1.2))], 22, 15, bold=True, what="the next step")
            self.text(slide, M + Inches(0.55), Inches(5.3), CW - Inches(0.9), Inches(1.4), next_step, nsize, WHITE,
                      True, anchor=MSO_ANCHOR.MIDDLE)


LAYOUTS = ["cover", "section", "cards", "stats", "two_column", "table", "numbered", "steps", "chart", "quote",
           "closing"]
# Layouts that carry the deck's argument; the word-count check applies to these.
CONTENT = {"cards", "stats", "two_column", "table", "numbered", "steps"}

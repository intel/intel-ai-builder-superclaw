#!/usr/bin/env python3
"""Build a themed PowerPoint deck from a JSON outline and check it, in one command.

Usage: python build_deck.py <deck.json>

deck.json: {"output": "/workspace/x/x.pptx", "theme": "blue",
            "slides": [{"layout": "cover", "title": "..."}, ...]}
"theme" is for a colour the user asked for: a theme name, a colour word or a hex colour such as
"#0068B5", which gets its own theme. Without it the theme is picked from the topic words in
the slide titles, so a history deck and an AI deck get different colours and a rebuild keeps its look.
Each slide's keys other than "layout" are that layout's fields (see layouts.py).
Every slide is checked in one run and the deck is always saved, leaving out slides with an ERROR, so
an agent short on steps still has a file to deliver.
Exit 0 = built and checks passed, 1 = built but a slide needs fixing, 2 = a slide is invalid.
"""

import inspect
import json
import os
import re
import sys
import zlib
from collections import Counter
from pathlib import Path
from typing import get_args

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layouts import CONTENT, LAYOUTS, THEMES, Deck, LayoutError, resolve_theme, words

MIN_WORDS = 40
PLACEHOLDER = re.compile(r"(?i)\b(lorem ipsum|todo|tbd|xxx|placeholder)\b|\[(insert|add|your)[^\]]*\]")
CJK = re.compile(r"[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]")
# Topic words per theme, English as whole words and Chinese as substrings.
TOPICS = {
    "blue": "business enterprise corporate strategy finance financial revenue sales market investment bank economy "
            "economic customer 商业 企业 战略 财务 金融 销售 市场 投资 银行 经济 客户",
    "teal": "technology tech software ai agent agents data cloud coding code developer computing digital automation "
            "llm 技术 科技 软件 人工智能 智能体 数据 代码 开发 计算 数字化 自动化 大模型",
    "green": "nature environment climate sustainability sustainable energy health wellness agriculture ecology "
             "green 自然 环境 气候 可持续 能源 健康 农业 生态 绿色",
    "amber": "history historical culture heritage tradition education food cooking recipe cuisine travel century "
             "war empire 历史 文化 传统 教育 美食 食物 烹饪 旅行 世纪 战争 帝国 王朝",
    "red": "security risk privacy safety threat crisis sports marketing campaign brand "
           "安全 风险 隐私 威胁 危机 体育 营销 品牌",
    "indigo": "science research physics space astronomy chemistry biology medicine medical "
              "科学 研究 物理 太空 天文 化学 生物 医学 医疗",
    "plum": "art arts design fashion music film creative beauty lifestyle 艺术 设计 时尚 音乐 电影 创意 美妆 生活",
}


def pick_theme(slides: list) -> str:
    """The theme whose topic words appear most in the titles (the cover counts triple)."""
    heads = [" ".join(str(s.get(k, "")) for k in ("title", "subtitle")) if isinstance(s, dict) else ""
             for s in slides]
    text = " ".join(heads[:1] * 3 + heads[1:]).lower()
    scores = {theme: sum(len(re.findall(rf"\b{re.escape(w)}\b", text)) if w.isascii() else text.count(w)
                         for w in keys.split())
              for theme, keys in TOPICS.items()}
    best = max(scores.values())
    names = [t for t, s in scores.items() if s == best] if best else list(THEMES)
    return names[zlib.crc32(heads[0].encode("utf-8")) % len(names)]


def slide_text(deck: Deck, index: int) -> str:
    shapes = deck.prs.slides[index].shapes
    texts = [s.text_frame.text for s in shapes if s.has_text_frame]
    texts += [c.text for s in shapes if s.has_table for row in s.table.rows for c in row.cells]
    return "\n".join(texts)


def accepts(annotation: object, value: object) -> bool:
    allowed = get_args(annotation) or (annotation,)
    if str in allowed:
        allowed += (int, float)
    return any(value is None if t is type(None) else isinstance(value, t) for t in allowed)


def check_fields(method, slide: dict) -> tuple[dict, list[str], str]:
    """(fields to pass, warnings, error). Optional fields that do not fit the layout are dropped."""
    params = inspect.signature(method).parameters
    fields, warnings = {}, []
    for key, value in slide.items():
        if key == "layout":
            continue
        param = params.get(key)
        if param is None:
            warnings.append(f"ignored field '{key}', which this layout does not take")
        elif not accepts(param.annotation, value):
            if param.default is inspect.Parameter.empty:
                return {}, warnings, f"'{key}' has the wrong type"
            warnings.append(f"ignored field '{key}', which has the wrong type for this layout")
        else:
            fields[key] = value
    missing = [k for k, p in params.items() if p.default is inspect.Parameter.empty and k not in fields]
    return fields, warnings, f"missing field '{missing[0]}'" if missing else ""


def output_path(value: str, deck_json: Path) -> tuple[Path, str]:
    """Where to save the deck, and a warning if the path had to change.

    The runtime maps /workspace in commands and tool paths but not inside deck.json, so on the
    native backend a /workspace output is mapped here; a relative output sits next to deck.json.
    On Windows /workspace is never the sandbox mount: a C:/workspace folder belongs to the user.
    """
    logical = value.replace("\\", "/")
    if re.match(r"/workspace(/|$)", logical) and (os.name == "nt" or not Path("/workspace").is_dir()):
        root = next((os.environ[k] for k in ("SUPERCLAW_PATH", "OPENCODE_DIRECTORY", "WINDOWS_SUPERCLAW_PATH")
                     if os.environ.get(k, "").strip()), "")
        if root:
            return Path(root.strip()) / logical[len("/workspace"):].lstrip("/"), ""
        target = deck_json.resolve().parent / Path(logical).name
        return target, f"output '{value}' is not a path on this computer; saved next to deck.json instead"
    path = Path(value)
    return (path if path.is_absolute() else deck_json.resolve().parent / path), ""


def drop_slides_after(deck: Deck, keep: int) -> None:
    ids = deck.prs.slides._sldIdLst
    for sld_id in list(ids)[keep:]:
        ids.remove(sld_id)
        deck.prs.part.drop_rel(sld_id.rId)


def main() -> None:
    spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    slides = spec.get("slides") or []
    if not slides or "output" not in spec:
        sys.exit("ERROR deck.json needs \"output\" and a non-empty \"slides\" list")
    warnings = []
    requested = str(spec.get("theme") or "")
    resolved = resolve_theme(requested) if requested else None
    if requested and not resolved:
        warnings.append(f"theme '{requested}' is not a theme name, colour word or hex colour such as #0068B5; "
                        "picked one from the topic instead")
    if resolved:
        theme, colors = resolved
    else:
        theme = pick_theme(slides)
        colors = THEMES[theme]
    if theme.startswith("#") and colors.main != theme[1:]:
        warnings.append(f"used #{colors.main}, a darker shade of {theme}, so white text on it stays readable")

    deck = Deck(colors)
    english = not CJK.search(str(slides[0].get("title", "")) if isinstance(slides[0], dict) else "")
    errors, skipped, uses = [], [], Counter()
    for number, slide in enumerate(slides, start=1):
        layout = slide.get("layout", "") if isinstance(slide, dict) else ""
        if layout not in LAYOUTS:
            errors.append(f"slide {number}: unknown layout '{layout}'; use one of: {', '.join(LAYOUTS)}")
            skipped.append(number)
            continue
        method = getattr(deck, layout)
        fields, notes, error = check_fields(method, slide)
        warnings.extend(f"slide {number} ({layout}): {note}" for note in notes)
        deck.number, deck.layout, deck.variant = number, layout, uses[layout] % 2
        built = len(deck.prs.slides)
        if not error:
            try:
                method(**fields)
            except (LayoutError, TypeError, ValueError, KeyError, IndexError, AttributeError) as exc:
                error = str(exc)
        if error:
            drop_slides_after(deck, built)
            errors.append(f"slide {number} ({layout}): {error}\n  fields: {layout}{inspect.signature(method)}")
            skipped.append(number)
            continue
        uses[layout] += 1
        foreign = CJK.findall(slide_text(deck, built)) if english else []
        if foreign:
            deck.issues.append(f"slide {number} ({layout}): Chinese text \"{''.join(foreign[:12])}\" in an English "
                               "deck; write it in English")
        body = {k: v for k, v in fields.items() if k not in ("title", "source")}
        if layout in CONTENT and words(body) < MIN_WORDS:
            warnings.append(f"slide {number} ({layout}) has only {words(body)} words besides the title; "
                            "add the supporting facts, numbers or examples from the source")
        found = PLACEHOLDER.search(json.dumps(fields, ensure_ascii=False))
        if found:
            deck.issues.append(f"slide {number} ({layout}): placeholder text '{found.group(0)}'; "
                               "replace it with real content")

    output, note = output_path(str(spec["output"]), Path(sys.argv[1]))
    if note:
        warnings.append(note)
    output.parent.mkdir(parents=True, exist_ok=True)
    deck.prs.save(str(output))
    for error in errors:
        print(f"ERROR {error}")
    for issue in deck.issues:
        print(f"FIX   {issue}")
    for warning in warnings + deck.warnings:
        print(f"WARN  {warning}")
    passed = not errors and not deck.issues
    left_out = f", left out slide{'s' if len(skipped) > 1 else ''} {', '.join(map(str, skipped))}" if skipped else ""
    print(f"{'PASS' if passed else 'FAIL'} - {output} ({len(deck.prs.slides)} slides{left_out}, theme {theme})")
    if not passed:
        print("The deck is saved. Fix every ERROR and FIX line above in one pass and run once more; "
              "if any remain after that, deliver the saved deck and tell the user which slides they are.")
    sys.exit(2 if errors else 1 if deck.issues else 0)


if __name__ == "__main__":
    main()

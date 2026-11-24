#!/usr/bin/env python3
"""Run RapidOCR on an image and emit detected text lines as JSON.

Output shape:
    {"text": "<all lines joined>", "lines": [{"confidence", "box"?}, ...]}

`text` is the canonical, ready-to-quote transcription, one detected line per
newline. It exists so the caller can echo one string verbatim instead of
re-typing characters out of per-line fragments. `lines[i]` carries line i's
confidence/box for layout-aware use, and deliberately not its text again: that
would put every character into the model's context twice.

An optional `region` restricts the read to part of the page — see run_region. It
is in image pixels, the same frame as `box`, so a line's box can be passed back
as a region unchanged.

Detection is built for text regions sitting inside a larger page. On a tight crop
(text fills the frame) it either finds nothing at all, or finds one box covering
almost the whole image and reads it worse than plain recognition does — measured
on OCRBench_v2 word crops, running detection first costs ~2.4 accuracy points
versus recognition-only. So a crop is routed around detection entirely, while a
real page still goes through it.

NOTE: `use_det=False` is sticky on a RapidOCR instance — after one such call,
later plain `ocr(path)` calls silently stay recognition-only even though
cfg.Global.use_det still reads True. This script does at most one recognition-only
call per process, so the order here is deliberate: never reuse the engine for a
detection pass afterwards.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Sequence

if TYPE_CHECKING:
    import numpy as np

# (x1, y1, x2, y2) in image pixels.
Rect = tuple[float, float, float, float]

# A detected box covering at least this fraction of the frame means the "page" is
# really a crop of a single text region, so detection has nothing to contribute.
# A genuine document page's largest text box sits well under this.
CROP_COVER = 0.3

# Below this crop height, recognition sees too few pixels per stroke: PP-OCR rec
# normalizes input to 48px tall, so a shorter crop is upscaled by the model
# anyway — doing it here with a proper interpolation reads measurably better.
MIN_REC_HEIGHT = 32
UPSCALE = 2.0

# A detected line belongs to the requested region once this much of its area sits
# inside it. Lines straddling the border are common (a region rarely lands exactly
# on a detection box), so requiring containment would drop real text; a majority
# rule keeps the line that is mostly inside and rejects a neighbour clipped at one
# edge.
KEEP_OVERLAP = 0.5


def fail(message: str) -> int:
    """Report a failure on stdout, not stderr.

    `uv run` reports exit code 0 even when this script exits non-zero, so the
    exit status cannot carry the failure and stderr is not what the caller reads.
    An error left on stderr alone therefore reaches the model as empty output,
    which reads as "this image has no text" — a wrong answer rather than an
    error. The wrapper looks for this `error` key. The non-zero return is kept
    for direct invocation, where it still means something.
    """
    print(json.dumps({"error": message}))
    return 1


def emit(
    result: Any,
    keep: Sequence[int] | None = None,
    offset: tuple[int, int] = (0, 0),
) -> int:
    """Serialize a RapidOCR result. Recognition-only results carry txts/scores
    but no boxes, so `box` is omitted rather than faked when absent.

    `keep` selects a subset of line indices (a region read). `offset` is the
    (x, y) origin of the image the result came from within the source image —
    non-zero when OCR ran on a crop — and is added to every box so `box` is
    always in source-image pixels.
    """
    # Explicit None checks: these fields may be NumPy arrays, whose truth value
    # raises for more than one element.
    txts = getattr(result, "txts", None)
    txts = [] if txts is None else txts
    scores = getattr(result, "scores", None)
    scores = [] if scores is None else scores
    boxes = getattr(result, "boxes", None)

    indices = range(min(len(txts), len(scores))) if keep is None else keep
    lines = []
    for i in indices:
        line = {"confidence": float(scores[i])}
        if boxes is not None:
            line["box"] = [[x + offset[0], y + offset[1]] for x, y in boxes[i].tolist()]
        lines.append(line)

    doc = {"text": "\n".join(txts[i] for i in indices), "lines": lines}

    print(json.dumps(doc, ensure_ascii=False))
    return 0


def is_crop(result: Any, path: Path) -> bool:
    """True when this image should skip detection and be read as a single line.

    Two cases: detection produced no boxes at all (RapidOCR may still hand back
    recognition text here, but recognizing the frame ourselves lets us upscale a
    small crop first), or its biggest box covers most of the frame.
    """
    boxes = getattr(result, "boxes", None)
    if boxes is None or len(boxes) == 0:
        return True
    return largest_box_coverage(boxes, path) >= CROP_COVER


def largest_box_coverage(boxes: Any, path: Path) -> float:
    """Fraction of the image covered by the biggest detected box, or 0.0 when the
    image can't be measured."""
    try:
        import cv2
        import numpy as np

        image = cv2.imread(str(path))
        if image is None or not image.size:
            return 0.0
        area = image.shape[0] * image.shape[1]
        if not area:
            return 0.0
        biggest = max(cv2.contourArea(np.array(b, dtype=np.float32)) for b in boxes)
        return biggest / area
    except Exception:
        return 0.0


def recognize_whole_image(ocr: Any, path: Path) -> Any:
    """Recognition-only pass, treating the whole frame as one text line. Small
    crops are upscaled first — see MIN_REC_HEIGHT."""
    image = None
    try:
        import cv2

        image = cv2.imread(str(path))
        if image is not None and image.shape[0] < MIN_REC_HEIGHT:
            image = cv2.resize(image, None, fx=UPSCALE, fy=UPSCALE,
                               interpolation=cv2.INTER_CUBIC)
    except Exception:
        image = None  # any imread/resize trouble: hand the path over untouched

    return ocr(image if image is not None else str(path),
               use_det=False, use_cls=False)


def parse_region(raw: object) -> Rect | None:
    """Validate a caller-supplied region, returning (x1, y1, x2, y2) or None.

    Rejecting a malformed region instead of clamping it is deliberate: a silently
    repaired box would return text from the wrong part of the page, which reads as
    a plausible answer and is therefore worse than an error.
    """
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        raise ValueError("region must be [x1, y1, x2, y2]")
    # float() would also accept "10" and True; a region is numbers or nothing.
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in raw):
        raise ValueError("region values must be numbers")
    x1, y1, x2, y2 = (float(v) for v in raw)
    if min(x1, y1) < 0:
        raise ValueError("region values must not be negative")
    if x2 <= x1 or y2 <= y1:
        raise ValueError("region needs x2 > x1 and y2 > y1")
    return x1, y1, x2, y2


def box_overlap(box: Sequence[Sequence[float]], rect: Rect) -> float:
    """Fraction of a detected box's area lying inside rect. The box is a rotated
    quad; its axis-aligned bounds are enough to decide membership and avoid a
    polygon-clipping dependency."""
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    ax1, ay1, ax2, ay2 = min(xs), min(ys), max(xs), max(ys)
    bx1, by1, bx2, by2 = rect
    inner_w = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    inner_h = max(0.0, min(ay2, by2) - max(ay1, by1))
    area = (ax2 - ax1) * (ay2 - ay1)
    return 0.0 if area <= 0 else (inner_w * inner_h) / area


def crop_rect(image: np.ndarray, rect: Rect) -> tuple[np.ndarray, tuple[int, int]]:
    """Slice rect out of image, clamped to the frame and never empty. Returns the
    crop and its (x, y) origin in the image."""
    height, width = image.shape[:2]
    x1 = max(0, min(width - 1, int(round(rect[0]))))
    y1 = max(0, min(height - 1, int(round(rect[1]))))
    x2 = max(x1 + 1, min(width, int(round(rect[2]))))
    y2 = max(y1 + 1, min(height, int(round(rect[3]))))
    return image[y1:y2, x1:x2], (x1, y1)


def run_region(ocr: Any, path: Path, region: Rect) -> int:
    """Read only the caller's region of the page.

    Detection runs on the whole page and lines outside the region are dropped,
    rather than cropping to the region first. Detection is more accurate with the
    surrounding page for context and a crop boundary can clip glyphs: measured on
    OCRBench_v2's 200 'fine-grained text recognition en' samples, filtering page
    lines scores 64.68 against 60.36 for cropping then detecting.

    The CROP_COVER heuristic must not run here. Its premise is that a box filling
    the frame means the image is a single-line crop, but a region crop trips that
    by construction — routing to recognition-only then mashes a multi-line region
    into one garbled line, worth 18.21 on the same samples.
    """
    import cv2

    image = cv2.imread(str(path))
    if image is None:
        return fail(f"Could not read image: {path}")
    height, width = image.shape[:2]
    # Checked here, not in parse_region, because only now is the size known.
    # Rejected rather than clamped for the same reason as in parse_region.
    if region[2] > width or region[3] > height:
        return fail(f"region {list(region)} lies outside the {width}x{height} image")

    result = ocr(image)
    boxes = getattr(result, "boxes", None)
    keep = ([i for i, box in enumerate(boxes) if box_overlap(box, region) >= KEEP_OVERLAP]
            if boxes is not None else [])
    if keep:
        return emit(result, keep=keep)

    # No line detected inside the region. Detection on the full page can miss
    # isolated scene text that reads fine once it is the only thing in frame, so
    # retry on the region alone before giving up. Recognition-only comes last
    # because use_det=False is sticky on the instance (see module docstring).
    crop, origin = crop_rect(image, region)
    result = ocr(crop)
    txts = getattr(result, "txts", None)
    if txts is not None and len(txts):
        return emit(result, offset=origin)

    if crop.shape[0] < MIN_REC_HEIGHT:
        crop = cv2.resize(crop, None, fx=UPSCALE, fy=UPSCALE,
                          interpolation=cv2.INTER_CUBIC)
    return emit(ocr(crop, use_det=False, use_cls=False))


def main(argv: list[str]) -> int:
    # ocr.ts decodes stdout as UTF-8. A Windows pipe otherwise gets the ANSI code
    # page, which cannot encode CJK text.
    sys.stdout.reconfigure(encoding="utf-8")
    if len(argv) < 2:
        return fail("A single JSON payload argument is required.")

    payload = json.loads(argv[1])
    file_path = payload.get("file_path", "")
    if not file_path:
        return fail("file_path is required.")

    try:
        region = parse_region(payload.get("region"))
    except ValueError as exc:
        return fail(str(exc))

    path = Path(file_path)
    if not path.is_absolute():
        return fail(f"file_path must be an absolute path: {file_path}")
    if not path.exists():
        return fail(f"File not found: {file_path}")

    from rapidocr import EngineType, RapidOCR

    ocr = RapidOCR(
        params={
            "Det.engine_type": EngineType.ONNXRUNTIME,
            "Cls.engine_type": EngineType.ONNXRUNTIME,
            "Rec.engine_type": EngineType.ONNXRUNTIME,
        }
    )

    if region is not None:
        try:
            return run_region(ocr, path, region)
        except Exception as exc:
            return fail(f"OCR failed on {file_path}: {exc}")

    try:
        result = ocr(str(path))
    except Exception as exc:
        return fail(f"OCR failed on {file_path}: {exc}")

    if is_crop(result, path):
        try:
            result = recognize_whole_image(ocr, path)
        except Exception as exc:
            return fail(f"OCR failed on {file_path}: {exc}")

    return emit(result)


if __name__ == "__main__":
    sys.exit(main(sys.argv))

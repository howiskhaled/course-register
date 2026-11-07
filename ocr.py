"""On-device text recognition for schedule screenshots (macOS Vision framework).

Nothing leaves the computer. Returns the recognised lines, top-to-bottom, left-to-right.
Windows/Linux: not available yet -> `available()` is False and the UI offers paste/search instead.
"""
from __future__ import annotations

import sys


def available() -> bool:
    if sys.platform != "darwin":
        return False
    try:
        import Vision  # noqa: F401
        import Quartz  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def recognize(image_bytes: bytes) -> list[str]:
    import Quartz
    import Vision
    from Foundation import NSData

    data = NSData.dataWithBytes_length_(image_bytes, len(image_bytes))
    src = Quartz.CGImageSourceCreateWithData(data, None)
    if src is None or Quartz.CGImageSourceGetCount(src) == 0:
        raise ValueError("That file isn't an image macOS can read.")
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)

    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(False)  # course codes aren't words
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        raise RuntimeError(f"Text recognition failed: {err}")

    items = []
    for obs in req.results() or []:
        cand = obs.topCandidates_(1)
        if not cand:
            continue
        box = obs.boundingBox()  # normalised, origin bottom-left
        items.append((round(1 - box.origin.y - box.size.height, 3), round(box.origin.x, 3), str(cand[0].string())))
    items.sort()
    return [t for _, _, t in items]


if __name__ == "__main__":  # python ocr.py screenshot.png
    for line in recognize(open(sys.argv[1], "rb").read()):
        print(line)

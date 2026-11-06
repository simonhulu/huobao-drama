"""Inpaint small branding regions while preserving all other real player pixels."""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def repair_region(source, mask, bounds):
    height, width = mask.shape
    left, top, right, bottom = bounds
    margin = max(4, min(20, round(max(right - left, bottom - top) * .4)))
    left, top = max(0, left - margin), max(0, top - margin)
    right, bottom = min(width, right + margin), min(height, bottom + margin)
    patch = source[top:bottom, left:right]
    local_mask = mask[top:bottom, left:right].copy()
    working = patch[:, :, :3].copy()
    support = (patch[:, :, 3] >= 250) & (local_mask == 0)
    if np.count_nonzero(support) >= 12:
        lab = cv2.cvtColor(working, cv2.COLOR_BGR2LAB).astype(np.float32)
        hsv = cv2.cvtColor(working, cv2.COLOR_BGR2HSV)
        colored = support & (hsv[:, :, 1] >= 60) & (hsv[:, :, 2] >= 80)
        palette = support
        if np.count_nonzero(colored) >= np.count_nonzero(support) * .35:
            histogram = np.bincount((hsv[:, :, 0][colored] // 5), minlength=36)
            scores = sum(np.roll(histogram, shift) for shift in range(-2, 3))
            hue = int(np.argmax(scores)) * 5 + 2
            distance = np.abs(hsv[:, :, 0].astype(np.int16) - hue)
            palette = colored & (np.minimum(distance, 180 - distance) <= 12)
        center = np.median(lab[palette], axis=0)
        target_surface = np.linalg.norm(lab - center, axis=2) < 35
        inliers = support & target_surface
        if np.count_nonzero(inliers) >= max(12, np.count_nonzero(support) * .2):
            foreign = (patch[:, :, 3] >= 250) & ~target_surface
            _, components = cv2.connectedComponents(foreign.astype(np.uint8), connectivity=8)
            edge_components = np.unique(components[foreign & (local_mask == 0)])
            protected = np.isin(components, edge_components[edge_components != 0]).astype(np.uint8)
            # A coarse logo box may cross pants, fingers or a collar; keep connected surfaces.
            protected = cv2.dilate(protected, np.ones((3, 3), np.uint8)) > 0
            local_mask[protected] = 0
            y, x = np.indices(local_mask.shape, dtype=np.float32)
            basis = np.stack((np.ones_like(x), x / max(1, x.shape[1]), y / max(1, y.shape[0])), axis=2)
            coefficients = np.linalg.lstsq(basis[inliers], working[inliers], rcond=None)[0]
            low, high = np.percentile(working[inliers], [5, 95], axis=0)
            background = np.clip(basis @ coefficients, low, high).astype(np.uint8)
            # Exclude nearby seams, collars and transparent RGB from inpainting donors.
            excluded = (local_mask == 0) & ~inliers
            working[excluded] = background[excluded]
    restored = cv2.inpaint(working, local_mask, max(2, min(width, height) / 200), cv2.INPAINT_TELEA)
    return (left, top, right, bottom), restored, local_mask


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--regions', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    source = cv2.imread(args.input, cv2.IMREAD_UNCHANGED)
    if source is None or source.ndim != 3 or source.shape[2] != 4:
        raise ValueError('Expected a transparent RGBA player PNG')
    height, width = source.shape[:2]
    regions = json.loads(Path(args.regions).read_text())
    mask = np.zeros((height, width), dtype=np.uint8)
    bounds = []
    for box in regions:
        x, y, w, h = (float(box[key]) for key in ('x', 'y', 'width', 'height'))
        if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 - x + .001 and 0 < h <= 1 - y + .001 and w * h <= .04):
            raise ValueError('Branding region is outside the permitted bounds')
        left, top = max(0, int(x * width) - 2), max(0, int(y * height) - 2)
        right, bottom = min(width, int(np.ceil((x + w) * width)) + 2), min(height, int(np.ceil((y + h) * height)) + 2)
        mask[top:bottom, left:right] = 255
        bounds.append((left, top, right, bottom))
    mask[source[:, :, 3] < 250] = 0
    output = source.copy()
    for box in bounds:
        (left, top, right, bottom), restored, local_mask = repair_region(source, mask, box)
        output[top:bottom, left:right, :3][local_mask > 0] = restored[local_mask > 0]
    if not cv2.imwrite(args.output, output):
        raise ValueError('Could not write cleaned player PNG')
    print(json.dumps({'width': width, 'height': height, 'regions': len(regions), 'changedPixels': int(np.count_nonzero(mask))}))


if __name__ == '__main__':
    main()

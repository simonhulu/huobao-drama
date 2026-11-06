"""Rebuild compact, source-backed eastern-China geography without GIS dependencies.

Inputs are the unmodified source ZIPs in the supplied cache directory. Outputs
retain source hashes; the production renderer reads only the compact GeoJSON.
"""
import argparse
import datetime
import hashlib
import gzip
import json
import pathlib
import struct
import zipfile

EXTENT = [109, 30, 124, 42.5]
HERE = pathlib.Path(__file__).resolve().parent


def intersects(box):
    return box[0] <= EXTENT[2] and box[2] >= EXTENT[0] and box[1] <= EXTENT[3] and box[3] >= EXTENT[1]


def records(archive):
    """Read SHP/DBF records in lockstep, rejecting features by native bbox first."""
    with zipfile.ZipFile(archive) as z:
        shp = z.open(next(n for n in z.namelist() if n.endswith('.shp')))
        dbf = z.open(next(n for n in z.namelist() if n.endswith('.dbf')))
        h = dbf.read(32)
        count, header_length, record_length = struct.unpack_from('<IHH', h, 4)
        descriptors = dbf.read(header_length - 32)
        fields = []
        offset = 1
        for index in range(0, len(descriptors) - 1, 32):
            descriptor = descriptors[index:index + 32]
            name = descriptor[:11].split(b'\0')[0].decode('ascii')
            length = descriptor[16]
            fields.append((name, chr(descriptor[11]), offset, length))
            offset += length
        shp.read(100)
        for _ in range(count):
            header = shp.read(8)
            if not header:
                break
            record_number, length = struct.unpack('>II', header)
            raw = shp.read(length * 2)
            attributes = dbf.read(record_length)
            shape_type = struct.unpack_from('<I', raw, 0)[0]
            if shape_type not in [3, 5]:
                continue
            box = struct.unpack_from('<4d', raw, 4)
            if not intersects(box):
                continue
            values = {}
            for name, kind, start, size in fields:
                text = attributes[start:start + size].strip().decode('utf-8', errors='replace')
                if kind in ['N', 'F'] and text:
                    try:
                        values[name] = float(text) if '.' in text else int(text)
                    except ValueError:
                        values[name] = None
                else:
                    values[name] = text
            parts, points = struct.unpack_from('<II', raw, 36)
            starts = list(struct.unpack_from(f'<{parts}I', raw, 44)) + [points]
            coordinates = list(struct.iter_unpack('<dd', raw[44 + 4 * parts:44 + 4 * parts + 16 * points]))
            lines = [[[round(x, 6), round(y, 6)] for x, y in coordinates[starts[i]:starts[i + 1]]] for i in range(parts)]
            yield record_number, values, lines


def clip_ring(ring):
    points = ring[:-1] if ring and ring[0] == ring[-1] else ring
    for axis, edge, sign in [(0, EXTENT[0], 1), (0, EXTENT[2], -1), (1, EXTENT[1], 1), (1, EXTENT[3], -1)]:
        result = []
        if not points:
            break
        previous = points[-1]
        previous_inside = (previous[axis] - edge) * sign >= 0
        for current in points:
            inside = (current[axis] - edge) * sign >= 0
            if inside != previous_inside:
                amount = (edge - previous[axis]) / (current[axis] - previous[axis])
                result.append([round(previous[i] + amount * (current[i] - previous[i]), 6) for i in range(2)])
            if inside:
                result.append(current)
            previous, previous_inside = current, inside
        points = result
    return points + [points[0]] if len(points) >= 3 else []


def area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2


def polygon_parts(rings):
    polygons = []
    for ring in rings:
        clipped = clip_ring(ring)
        if not clipped:
            continue
        if area(ring) < 0 or not polygons:
            polygons.append([clipped])
        else:
            polygons[-1].append(clipped)
    return polygons


def save(filename, features, archive, url, title, license_text, license_url):
    data = {'type': 'FeatureCollection', 'bbox': EXTENT, 'features': features}
    target = HERE / filename
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n'
    uncompressed = payload.encode()
    encoded = gzip.compress(uncompressed, compresslevel=9, mtime=0) if filename.endswith('.gz') else uncompressed
    target.write_bytes(encoded)
    metadata = {
        'title': title, 'url': url, 'license': license_text, 'licenseUrl': license_url,
        'downloadedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'sourceSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'sha256': hashlib.sha256(encoded).hexdigest(), 'bounds': EXTENT,
        'processing': 'SHP/DBF extraction; source geometry rounded to six decimal degrees; polygon clipping to regional extent; river records retain native geometry and are clipped at render preparation.',
        'featureCount': len(features), 'historyStatus': 'modern geographic context, not reconstructed historical waterways or coastlines',
    }
    if filename.endswith('.gz'):
        metadata.update({'compression': 'gzip', 'uncompressedSha256': hashlib.sha256(uncompressed).hexdigest()})
    target.with_suffix(target.suffix + '.source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    print(filename, len(features), len(payload.encode()))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('cache', type=pathlib.Path)
    parser.add_argument('--only', choices=['hydro', 'ocean', 'land', 'lakes', 'regions'])
    args = parser.parse_args()
    names = {
        'hydro': 'HydroRIVERS_v10_as_shp', 'ocean': 'ne_50m_ocean', 'land': 'ne_10m_land',
        'lakes': 'ne_10m_lakes', 'regions': 'ne_10m_geography_regions_polys',
    }
    for kind, basename in names.items():
        if args.only and kind != args.only:
            continue
        archive = args.cache / (basename + '.zip')
        if not zipfile.is_zipfile(archive):
            continue
        features = []
        for record_id, values, lines in records(archive):
            if kind == 'hydro':
                if values['ORD_STRA'] < 3:
                    continue
                properties = {key: values[key] for key in ['HYRIV_ID', 'MAIN_RIV', 'ORD_STRA', 'ORD_CLAS', 'DIS_AV_CMS', 'LENGTH_KM']}
                geometry = {'type': 'MultiLineString', 'coordinates': lines}
            else:
                properties = {key: value for key, value in values.items() if value not in [None, '']}
                polygons = polygon_parts(lines)
                if not polygons:
                    continue
                geometry = {'type': 'MultiPolygon', 'coordinates': polygons}
            features.append({'type': 'Feature', 'id': record_id, 'properties': properties, 'geometry': geometry})
        if kind == 'hydro':
            save('hydrorivers-east-china.geojson.gz', features, archive,
                 'https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_as_shp.zip',
                 'HydroRIVERS v1.0 Asia — eastern-China extract, Strahler order >= 3',
                 'HydroSHEDS license — scientific, educational and commercial use permitted with attribution',
                 'https://www.hydrosheds.org/products/hydrorivers')
        else:
            scale = '50m' if kind == 'ocean' else '10m'
            save(f'{kind}-east-china.geojson', features, archive,
                 f'https://naturalearth.s3.amazonaws.com/{scale}_physical/{basename}.zip',
                 f'Natural Earth {basename} — eastern-China extract', 'Public Domain',
                 'https://www.naturalearthdata.com/about/terms-of-use/')


if __name__ == '__main__':
    main()

"""Render an original fictional terrain plate and matching screen coordinates."""

import json
import math
from pathlib import Path
import random
import time

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector, noise


ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "remotion/public/history-map-demo"
DELIVERY = ROOT / "data/static/history-map-demo-20261024"
WIDTH, HEIGHT = 1920, 1080
SEED = 20261024
random.seed(SEED)
START = time.monotonic()

ROUTES = {
    "redMain": [(-7, -1), (-4, -0.6), (-2, 0), (-0.8, 0.2)],
    "redFlank": [(-7, -1), (-6, 3.2), (-2.7, 4), (1.5, 3.8), (3.6, 2.3)],
    "blueAdvance": [(6, 1), (3, 0.8), (1.1, 0.3)],
    "blueRetreat": [(1.1, 0.3), (3.5, -1), (6, -2.8)],
}


def river_center(y):
    return 0.38 * math.sin(y * 0.58) + 0.17 * math.sin(y * 1.22 + 0.4)


def segment_distance(x, y, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = max(0, min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)


def height(x, y):
    peaks = [
        (-10, 4.6, 2.6, 2.4, 1.7), (-7.1, 6.2, 3.2, 1.6, 1.3),
        (-3.2, 6.2, 2.75, 1.45, 1.3), (3.1, 6.2, 2.4, 1.7, 1.5),
        (7.8, 5.5, 3.35, 2.1, 1.7), (11, 2.6, 2.1, 2.3, 1.8),
        (-9, -4.6, 2.9, 2.3, 1.65), (-4.6, -4.8, 3.0, 1.8, 1.5),
        (2.2, -5.4, 2.6, 1.6, 1.45), (7.4, -5.6, 2.9, 2.2, 1.6),
        (-12.7, -0.4, 1.7, 1.7, 2.1), (13, -2, 1.8, 1.8, 2.1),
    ]
    mountain = sum(amp * math.exp(-((x - px) / sx) ** 2 - ((y - py) / sy) ** 2)
                   for px, py, amp, sx, sy in peaks)
    coarse = noise.noise_vector(Vector((x * .58, y * .58, 4.1)))[0]
    fine = noise.noise_vector(Vector((x * 2.1, y * 2.1, 1.3)))[1]
    ridge = noise.noise_vector(Vector((x * 1.1, y * 1.1, 7.7)))[2]
    z = .24 + mountain * (1.12 + .42 * coarse + .22 * ridge) + .09 * coarse + .035 * fine
    route_distance = min(segment_distance(x, y, a, b)
                         for route in ROUTES.values() for a, b in zip(route, route[1:]))
    corridor = math.exp(-(route_distance / .65) ** 2)
    z = .22 + (z - .22) * (1 - .83 * corridor)
    village = math.exp(-(((x - 1.8) / 1.5) ** 4 + ((y + .9) / 1.3) ** 4))
    z = z * (1 - .8 * village) + .23 * .8 * village
    river_d = abs(x - river_center(y))
    z = .052 + max(0, z - .052) * (1 - math.exp(-(river_d / .48) ** 4))
    return z


def material(name, color, roughness=.8, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    return mat


def cube(name, location, scale, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("Soft stone edges", "BEVEL")
        mod.width, mod.segments = bevel, 2
    return obj


def curve(name, points, mat, thickness):
    data = bpy.data.curves.new(name, "CURVE")
    data.dimensions = "3D"
    data.resolution_u = 1
    data.bevel_depth = thickness
    data.bevel_resolution = 2
    spline = data.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for point, xyz in zip(spline.points, points):
        point.co = (*xyz, 1)
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def terrain():
    nx, ny = 360, 270
    verts, faces = [], []
    for j in range(ny + 1):
        y = -12 + j * 24 / ny
        for i in range(nx + 1):
            x = -17 + i * 34 / nx
            verts.append((x, y, height(x, y)))
    for j in range(ny):
        for i in range(nx):
            a = j * (nx + 1) + i
            faces.append((a, a + 1, a + nx + 2, a + nx + 1))
    mesh = bpy.data.meshes.new("Original fictional relief")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Terrain", mesh)
    bpy.context.collection.objects.link(obj)
    colors = mesh.color_attributes.new(name="TerrainColor", type="FLOAT_COLOR", domain="POINT")
    low, high = (.075, .19, .10), (.48, .49, .38)
    for i, (x, y, z) in enumerate(verts):
        slope = math.hypot(height(x + .08, y) - z, height(x, y + .08) - z) / .08
        t = min(1, max(0, (z - .65) / 2.3 + slope * .20))
        variation = .045 * noise.noise_vector(Vector((x * 1.5, y * 1.5, 3)))[2]
        rgb = tuple(max(0, min(1, a * (1 - t) + b * t + variation)) for a, b in zip(low, high))
        colors.data[i].color = (*rgb, 1)
    mat = material("Sage forest and limestone", low)
    tree = mat.node_tree
    attr = tree.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "TerrainColor"
    tree.links.new(attr.outputs["Color"], tree.nodes.get("Principled BSDF").inputs["Base Color"])
    tex = tree.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = 7
    tex.inputs["Detail"].default_value = 3
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = .18
    bump.inputs["Distance"].default_value = .085
    tree.links.new(tex.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], tree.nodes.get("Principled BSDF").inputs["Normal"])
    obj.data.materials.append(mat)
    for polygon in mesh.polygons:
        polygon.use_smooth = True


def river():
    water = material("Deep jade river", (.075, .31, .34), .28, .12)
    bank = material("Pale river gravel", (.46, .46, .35), .95)
    for name, width, z, mat in [("River gravel", .38, .09, bank), ("River", .26, .115, water)]:
        verts, faces = [], []
        n = 280
        for i in range(n + 1):
            y = -13 + 26 * i / n
            half = width * (1 + .16 * math.sin(y * 1.3))
            verts.extend([(river_center(y) - half, y, z), (river_center(y) + half, y, z)])
        for i in range(n):
            faces.append((i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2))
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(verts, [], faces)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.data.materials.append(mat)
    glint = material("River flow glints", (.24, .52, .52), .4)
    for i in range(32):
        y = random.uniform(-9, 9)
        x = river_center(y) + random.uniform(-.12, .12)
        curve("River ripple", [(x, y, .12), (x + .015, y + random.uniform(.09, .22), .12)], glint, .008)


def settlements():
    stone = material("Warm grey masonry", (.48, .46, .38))
    roof = material("Old charcoal roof tiles", (.17, .21, .20))
    wood = material("Bridge timber", (.35, .28, .19))
    plaster = material("Muted pale plaster", (.66, .65, .52))
    x, y = river_center(.3), .3
    cube("Central crossing", (x, y, .25), (1.32, .35, .13), stone, .045)
    for sign in [-1, 1]:
        cube("Bridge parapet", (x, y + sign * .18, .38), (1.32, .055, .17), stone, .015)
    for i in range(10):
        cube("Bridge decking", (x - .6 + i * .13, y, .325), (.035, .29, .025), wood)
    cx, cy = 1.85, -.98
    base = height(cx, cy)
    for dx, dy, sx, sy in [(-.84, 0, .1, 1.25), (.84, 0, .1, 1.25), (0, -.64, 1.7, .1), (0, .64, 1.7, .1)]:
        cube("Town wall", (cx + dx, cy + dy, base + .2), (sx, sy, .37), stone, .025)
    for dx in [-.83, .83]:
        for dy in [-.63, .63]:
            cube("Watchtower", (cx + dx, cy + dy, base + .32), (.24, .24, .6), stone, .025)
            cube("Tower roof", (cx + dx, cy + dy, base + .66), (.36, .34, .1), roof, .04)
    for dx, dy, sx, sy in [(-.35, -.22, .45, .35), (.3, -.2, .4, .4), (-.1, .28, .65, .3)]:
        cube("Courtyard building", (cx + dx, cy + dy, base + .2), (sx, sy, .36), plaster, .02)
        bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=1, radius2=.3, depth=.18,
                                       location=(cx + dx, cy + dy, base + .46), rotation=(0, 0, math.pi / 4))
        obj = bpy.context.object
        obj.name = "Hipped tile roof"
        obj.scale = (sx * .9, sy * 1.05, 1)
        obj.data.materials.append(roof)


def trees():
    foliage = material("Pine forest", (.11, .20, .15), .95)
    trunk = material("Pine trunks", (.24, .21, .16))
    bpy.ops.mesh.primitive_cone_add(vertices=7, radius1=1, radius2=0, depth=2, location=(0, 0, -20))
    template = bpy.context.object
    template.name = "Tree mesh source"
    template.data.materials.append(foliage)
    clusters = [(random.uniform(-13, 13), random.uniform(-8, 8)) for _ in range(35)]
    for i in range(1100):
        cx, cy = clusters[i % len(clusters)]
        x, y = random.gauss(cx, .7), random.gauss(cy, .7)
        z = height(x, y)
        d = min(segment_distance(x, y, a, b) for route in ROUTES.values() for a, b in zip(route, route[1:]))
        if z < .28 or z > 2.2 or abs(x - river_center(y)) < .6 or d < .35:
            continue
        if abs(x - 1.85) < 1.15 and abs(y + .98) < .9:
            continue
        size = random.uniform(.08, .30)
        obj = bpy.data.objects.new("Pine", template.data)
        obj.location = (x, y, z + size * .95)
        obj.scale = (size * .65, size * .65, size)
        obj.rotation_euler.z = random.random() * math.tau
        bpy.context.collection.objects.link(obj)
    bpy.data.objects.remove(template, do_unlink=True)


def configure():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = WIDTH, HEIGHT
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.world.color = (.35, .35, .35)
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (.49, .59, .62, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = .22
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = -.35
    bpy.ops.object.light_add(type="SUN", location=(-10, -8, 18))
    sun = bpy.context.object
    sun.name = "Soft late afternoon sun"
    sun.rotation_euler = (math.radians(43), math.radians(-34), math.radians(-32))
    sun.data.energy = 2.4
    sun.data.angle = math.radians(5)
    bpy.ops.object.light_add(type="AREA", location=(-2, -7, 18))
    area = bpy.context.object
    area.data.energy, area.data.shape, area.data.size = 650, "DISK", 16
    bpy.ops.object.camera_add(location=(0, -18.0, 35.0))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, .3, .1)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 27.1
    camera.data.lens = 50
    scene.camera = camera
    scene.render.filepath = str(ASSETS / "terrain.png")
    return scene, camera


def sampled_route(points, count=100):
    lengths = [math.dist(a, b) for a, b in zip(points, points[1:])]
    total = sum(lengths)
    result = []
    for i in range(count):
        remaining = total * i / (count - 1)
        for j, length in enumerate(lengths):
            if remaining <= length or j == len(lengths) - 1:
                t = max(0, min(1, remaining / length))
                a, b = points[j], points[j + 1]
                result.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                break
            remaining -= length
    return result


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    DELIVERY.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    terrain()
    river()
    settlements()
    trees()
    scene, camera = configure()
    bpy.context.view_layer.update()

    def project(point):
        x, y = point
        co = world_to_camera_view(scene, camera, Vector((x, y, height(x, y) + .1)))
        return {"x": round(co.x * WIDTH, 3), "y": round((1 - co.y) * HEIGHT, 3)}

    data = {
        "width": WIDTH, "height": HEIGHT, "seed": SEED,
        "historyStatus": "illustrative",
        "source": "Original procedural fictional terrain; no external geographic data.",
        "camera": {"type": "orthographic", "position": list(camera.location), "scale": camera.data.ortho_scale},
        "routes": {name: [project(p) for p in sampled_route(points)] for name, points in ROUTES.items()},
        "places": {name: project(point) for name, point in {
            "pass": (0, .3), "redCamp": (-7, -1), "blueCamp": (6, 1),
            "northRidge": (-2, 5), "river": (0, -3), "town": (1.85, -.98),
        }.items()},
    }
    (ASSETS / "scene.json").write_text(json.dumps(data, ensure_ascii=True, indent=2) + "\n")
    bpy.ops.wm.save_as_mainfile(filepath=str(DELIVERY / "terrain.blend"))
    bpy.ops.render.render(write_still=True)
    print("HISTORY_TERRAIN_DONE", json.dumps({"elapsedSeconds": round(time.monotonic() - START, 2),
          "image": str(ASSETS / "terrain.png"), "data": str(ASSETS / "scene.json")}))


if __name__ == "__main__":
    main()

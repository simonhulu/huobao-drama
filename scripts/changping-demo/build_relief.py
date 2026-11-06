"""Render a schematic Shangdang relief plate with an exact geographic projection."""

import math
from pathlib import Path
import time

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector, noise


ROOT = Path(__file__).resolve().parents[2]
IMAGE = ROOT / "remotion/public/changping-demo/relief.png"
BLEND = ROOT / "data/static/changping-demo-20261024/relief.blend"
WIDTH, HEIGHT = 1920, 1080
START = time.monotonic()


def world(lon, lat):
    return (lon - 110.8) / 4.2 * 32 - 16, (lat - 34.8) / 2.4 * 18 - 9


def elevation(lon, lat):
    taihang_center = 113.1 + (lat - 35.3) * .48
    taihang = .85 * math.exp(-((lon - taihang_center) / .19) ** 2)
    taihang *= math.exp(-((lat - 36.25) / 1.15) ** 6)
    taiyue = .8 * math.exp(-((lon - 111.95) / .29) ** 2 - ((lat - 36.58) / .55) ** 2)
    zhongtiao = .57 * math.exp(-((lat - (35.10 + (lon - 111.6) * .19)) / .12) ** 2)
    zhongtiao *= math.exp(-((lon - 111.65) / .72) ** 4)
    x, y = world(lon, lat)
    coarse = noise.noise_vector(Vector((x * .7, y * .7, 26.024)))[0]
    medium = noise.noise_vector(Vector((x * 2.3, y * 2.3, 12.6)))[1]
    fine = noise.noise_vector(Vector((x * 6.2, y * 6.2, 4.2)))[2]
    ranges = taihang + taiyue + zhongtiao
    z = .08 + ranges * (1 + .48 * coarse + .20 * medium) + .025 * coarse + .008 * fine
    for bx, by, sx, sy in [(112.924, 35.798, .24, .24), (112.88, 36.12, .30, .22)]:
        basin = math.exp(-((lon - bx) / sx) ** 2 - ((lat - by) / sy) ** 2)
        z = .08 + (z - .08) * (1 - .72 * basin)
    return z


def make_terrain():
    nx, ny = 400, 230
    vertices, faces = [], []
    for j in range(ny + 1):
        lat = 34.7 + j / ny * 2.6
        for i in range(nx + 1):
            lon = 110.7 + i / nx * 4.4
            x, y = world(lon, lat)
            vertices.append((x, y, elevation(lon, lat)))
    for j in range(ny):
        for i in range(nx):
            a = j * (nx + 1) + i
            faces.append((a, a + 1, a + nx + 2, a + nx + 1))
    mesh = bpy.data.meshes.new("Schematic Shangdang relief, not DEM")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Schematic mountain ranges and basins", mesh)
    bpy.context.collection.objects.link(obj)
    colors = mesh.color_attributes.new(name="ReliefColor", type="FLOAT_COLOR", domain="POINT")
    for i, (x, y, z) in enumerate(vertices):
        t = max(0, min(1, z / 1.2))
        # Restrained altitude shading remains neutral under red and blue overlays.
        low, high = (.71, .73, .70), (.49, .55, .49)
        colors.data[i].color = (*(a * (1 - t) + b * t for a, b in zip(low, high)), 1)
    material = bpy.data.materials.new("Pale grey green cartographic relief")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    shader = nodes.get("Principled BSDF")
    shader.inputs["Roughness"].default_value = .95
    color = nodes.new("ShaderNodeVertexColor")
    color.layer_name = "ReliefColor"
    material.node_tree.links.new(color.outputs["Color"], shader.inputs["Base Color"])
    obj.data.materials.append(material)
    for face in mesh.polygons:
        face.use_smooth = True


def main():
    IMAGE.parent.mkdir(parents=True, exist_ok=True)
    BLEND.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    make_terrain()
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = WIDTH, HEIGHT
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.filepath = str(IMAGE)
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (.76, .80, .78, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = .55
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = .15
    bpy.ops.object.light_add(type="SUN", location=(-8, -6, 20))
    sun = bpy.context.object
    sun.rotation_euler = (math.radians(42), math.radians(-36), math.radians(-28))
    sun.data.energy = 2.1
    sun.data.angle = math.radians(9)
    bpy.ops.object.camera_add(location=(0, 0, 100), rotation=(0, 0, 0))
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 32
    scene.camera = camera
    bpy.context.view_layer.update()
    for lon, lat in [(110.8, 37.2), (115.0, 34.8), (112.924, 35.798)]:
        x, y = world(lon, lat)
        p = world_to_camera_view(scene, camera, Vector((x, y, elevation(lon, lat))))
        expected = ((lon - 110.8) / 4.2 * WIDTH, (37.2 - lat) / 2.4 * HEIGHT)
        actual = (p.x * WIDTH, (1 - p.y) * HEIGHT)
        if math.dist(expected, actual) > .01:
            raise RuntimeError(f"Projection mismatch: {expected} vs {actual}")
        print("PROJECTION_OK", lon, lat, actual)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
    bpy.ops.render.render(write_still=True)
    print("CHANGPING_RELIEF_DONE", round(time.monotonic() - START, 2), str(IMAGE))


if __name__ == "__main__":
    main()

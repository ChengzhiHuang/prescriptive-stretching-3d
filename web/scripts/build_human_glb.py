"""Fit MakeHuman's hm08 body and skin weights to HumanRig, then export with Blender."""

import argparse
from collections import defaultdict
import json
from math import atan2, cos, pi, sin, sqrt
from pathlib import Path
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fit_torso import fit_exported_torso


def read_body(path):
    vertices = []
    faces = []
    group = None
    with path.open(encoding="utf-8") as source:
        for line in source:
            fields = line.split()
            if not fields:
                continue
            if fields[0] == "v":
                vertices.append(Vector(map(float, fields[1:4])))
            elif fields[0] == "g":
                group = fields[1]
            elif fields[0] == "f" and group == "body":
                faces.append(tuple(int(field.split("/")[0]) - 1 for field in fields[1:]))
    return vertices, faces


def source_landmarks(skeleton, vertices):
    landmarks = {}
    for name, bone in skeleton["bones"].items():
        indices = skeleton["joints"][bone["head"]]
        landmarks[name] = sum((vertices[i] for i in indices), Vector()) / len(indices)
    return landmarks


def human_rig():
    joints = {}

    def joint(name, parent, offset):
        point = Vector(offset)
        if parent is not None:
            point += joints[parent][1]
        joints[name] = (parent, point)

    # Local translations from web/src/engine/HumanRig.ts.
    joint("root", None, (0, 0.94, 0))
    joint("pelvis", "root", (0, 0, 0))
    joint("lumbar", "pelvis", (0, 0.05, -0.02))
    joint("thoracic", "lumbar", (0, 0.175, 0))
    joint("neck", "thoracic", (0, 0.275, 0.005))
    joint("head", "neck", (0, 0.095, 0.008))
    for side, sign in (("R", -1), ("L", 1)):
        joint("clavicle" + side, "thoracic", (sign * 0.022, 0.242, 0.112))
        joint("shoulder" + side, "clavicle" + side, (sign * 0.168, -0.006, -0.092))
        joint("elbow" + side, "shoulder" + side, (0, -0.285, 0))
        joint("wrist" + side, "elbow" + side, (0, -0.255, 0))
        joint("hip" + side, "pelvis", (sign * 0.096, -0.045, 0))
        joint("knee" + side, "hip" + side, (0, -0.43, 0))
        joint("ankle" + side, "knee" + side, (0, -0.415, 0))
    return joints


def destination_bone(source):
    name, _, side = source.partition(".")
    if name in {"root", "pelvis", "spine05"}:
        return "pelvis"
    if name in {"spine03", "spine04"}:
        return "lumbar"
    if name in {"spine01", "spine02", "breast"}:
        return "thoracic"
    if name.startswith("neck"):
        return "neck"
    if name.startswith(("clavicle", "shoulder")):
        return "clavicle" + side
    if name.startswith("upperarm"):
        return "shoulder" + side
    if name.startswith("lowerarm"):
        return "elbow" + side
    if name.startswith(("wrist", "metacarpal", "finger")):
        return "wrist" + side
    if name.startswith("upperleg"):
        return "hip" + side
    if name.startswith("lowerleg"):
        return "knee" + side
    if name.startswith(("foot", "toe")):
        return "ankle" + side
    # Eyes, jaw, lips and other facial joints follow the head as a unit.
    return "head"


def remap_weights(source_weights, count):
    weights = [defaultdict(float) for _ in range(count)]
    for bone, entries in source_weights.items():
        destination = destination_bone(bone)
        for index, weight in entries:
            weights[index][destination] += weight
    normalized = []
    for values in weights:
        retained = sorted(values.items(), key=lambda item: -item[1])[:4]
        total = sum(value for _, value in retained)
        normalized.append({name: value / total for name, value in retained} if total else {})
    return normalized


def interpolate(value, control_points):
    for (start, low), (end, high) in zip(control_points, control_points[1:]):
        if value <= end:
            return low + (high - low) * max(0, (value - start) / (end - start))
    return control_points[-1][1]


def smoothstep(low, high, value):
    amount = min(1, max(0, (value - low) / (high - low)))
    return amount * amount * (3 - 2 * amount)


class HeightProfile:
    """Monotone interpolation through joint heights, without creases at the knots."""

    def __init__(self, points):
        self.points = points
        slopes = [(high - low) / (end - start)
                  for (start, low), (end, high) in zip(points, points[1:])]
        self.tangents = [slopes[0], *(2 * a * b / (a + b) if a * b > 0 else 0
                                      for a, b in zip(slopes, slopes[1:])),
                         slopes[-1]]

    def __call__(self, y):
        for i, ((start, low), (end, high)) in enumerate(zip(self.points, self.points[1:])):
            if y <= end:
                span = end - start
                t = max(0, (y - start) / span)
                base = low + (high - low) * smoothstep(0, 1, t)
                return base + span * t * (1 - t) * (
                    (1 - t) * self.tangents[i] - t * self.tangents[i + 1])
        return self.points[-1][1]


def cross_section_axes(direction, front_hint):
    front = (front_hint - direction * front_hint.dot(direction)).normalized()
    side = front.cross(direction).normalized()
    return side, front


class ArmSection:
    def __init__(self, source_start, source_end, source_front, target_start, target_end,
                 width_scale, depth_scale):
        self.source_start = source_start
        source_delta = source_end - source_start
        self.source_direction = source_delta.normalized()
        self.source_side, self.source_front = cross_section_axes(self.source_direction, source_front)
        self.target_start = target_start
        target_delta = target_end - target_start
        self.target_direction = target_delta.normalized()
        self.target_side, self.target_front = cross_section_axes(self.target_direction, Vector((0, 0, 1)))
        self.length_scale = target_delta.length / source_delta.length
        self.width_scale = width_scale
        self.depth_scale = depth_scale

    def fit(self, point):
        relative = point - self.source_start
        return (self.target_start
                + self.target_direction * relative.dot(self.source_direction) * self.length_scale
                + self.target_side * relative.dot(self.source_side) * self.width_scale
                + self.target_front * relative.dot(self.source_front) * self.depth_scale)


class BodyFit:
    def __init__(self, landmarks, joints):
        self.leg = [landmarks[name] for name in ("foot.L", "lowerleg01.L", "upperleg01.L")]
        ankle, knee, hip = (joints[name][1].y for name in ("ankleL", "kneeL", "hipL"))
        self.height = HeightProfile([
            (-8.1676, 0.002), (self.leg[0].y, ankle), (self.leg[1].y, knee),
            (self.leg[2].y, hip), (landmarks["spine05"].y, joints["pelvis"][1].y),
            (landmarks["spine04"].y, joints["lumbar"][1].y),
            (landmarks["spine03"].y, 1.068),
            (landmarks["spine02"].y, joints["thoracic"][1].y),
            (landmarks["upperarm01.L"].y, joints["shoulderL"][1].y),
            (landmarks["neck01"].y, joints["neck"][1].y),
            (landmarks["head"].y, joints["head"][1].y), (8.4913, 1.742),
        ])
        shoulder, elbow, wrist, knuckle, tip = (landmarks[name] for name in
            ("upperarm01.L", "lowerarm01.L", "wrist.L", "finger3-1.L", "finger3-3.L"))
        thumbward = landmarks["finger2-1.L"] - landmarks["finger5-1.L"]
        self.elbow, self.wrist = elbow, wrist
        upper_direction = (elbow - shoulder).normalized()
        forearm_direction = (wrist - elbow).normalized()
        self.elbow_axis = (upper_direction + forearm_direction).normalized()
        self.wrist_axis = (forearm_direction + (knuckle - wrist).normalized()).normalized()

        target_shoulder = joints["shoulderL"][1]
        target_elbow = joints["elbowL"][1] + Vector((0.012, 0, 0))
        target_wrist = joints["wristL"][1] + Vector((0.012, 0, 0))
        self.upper_arm = ArmSection(shoulder, elbow, Vector((0, 0, 1)),
                                    target_shoulder, target_elbow, 0.104, 0.112)
        self.forearm = ArmSection(elbow, wrist, thumbward, target_elbow, target_wrist, 0.092, 0.102)
        hand_end = tip + (tip - knuckle).normalized() * 0.25
        self.hand = ArmSection(wrist, hand_end, thumbward, target_wrist,
                               target_wrist + Vector((0, -0.127, 0.006)), 0.090, 0.097)

    def torso(self, point):
        x, y, z = point
        width = interpolate(y, [(-1, 0.101), (1, 0.102), (4.5, 0.110),
                                (5.25, 0.112), (6, 0.101), (7.1, 0.097), (8.5, 0.100)])
        depth_offset = interpolate(y, [(-1, -0.010), (1.3, -0.018), (4.7, -0.014),
                                       (5.8, -0.012), (6.4, -0.025), (7.0, -0.040)])
        # Keep the pelvis and chest in the same contact envelope as the previous mannequin.
        depth_scale = interpolate(y, [(0, 0.098), (2.5, 0.095), (4.0, 0.103), (6, 0.102)])
        # Broaden the front plane into a neutral athletic chest while keeping its side contours.
        chest = interpolate(y, [(2.75, 1.48), (3.3, 1.43), (4.1, 1.38),
                                (4.6, 1.27), (5.15, 1.05)]) - 0.14 * (x / 1.3) ** 2
        chest_mask = (smoothstep(2.75, 3.36, y) * (1 - smoothstep(4.3, 5.15, y))
                      * smoothstep(0.68, 1.10, z) * (1 - smoothstep(1.03, 1.55, abs(x))))
        z += 0.92 * chest_mask * (chest - z)
        return Vector((x * width, self.height(y), z * depth_scale + depth_offset))

    def fit_leg(self, point, sign):
        x, y, z = point
        center_x = interpolate(y, [(center.y, center.x) for center in self.leg])
        center_z = interpolate(y, [(center.y, center.z) for center in self.leg])
        # Compress the source's wider stance without changing sole height or the contact plane.
        x = (0.096 + (abs(x) - center_x) * 0.101) * sign
        depth = z - center_z
        toe_scale = (1 - smoothstep(-7.88, -7.22, y)) * smoothstep(0.15, 0.78, depth)
        return Vector((x, self.height(y), depth * (0.104 - 0.027 * toe_scale)))

    def fit_arm(self, point, sign):
        local = Vector((abs(point.x), point.y, point.z))
        elbow = smoothstep(-0.58, 0.58, (local - self.elbow).dot(self.elbow_axis))
        wrist = smoothstep(-0.30, 0.33, (local - self.wrist).dot(self.wrist_axis))
        fitted = self.upper_arm.fit(local).lerp(self.forearm.fit(local), elbow)
        fitted = fitted.lerp(self.hand.fit(local), wrist)
        fitted.x *= sign
        return fitted

    def __call__(self, point, weights):
        side, sign = ("R", -1) if point.x < 0 else ("L", 1)
        fit = self.torso(point)
        leg = sum(weights.get(bone + side, 0) for bone in ("hip", "knee", "ankle"))
        arm = sum(weights.get(bone + side, 0) for bone in ("shoulder", "elbow", "wrist"))
        if leg:
            fit = fit.lerp(self.fit_leg(point, sign), smoothstep(0.04, 0.91, leg))
        if arm:
            fit = fit.lerp(self.fit_arm(point, sign), smoothstep(0.04, 0.92, arm))
        return fit


def to_blender(vector):
    return vector.x, -vector.z, vector.y


def create_armature(joints):
    armature = bpy.data.armatures.new("HumanRig")
    obj = bpy.data.objects.new("HumanRig", armature)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    for name, (parent, point) in joints.items():
        bone = armature.edit_bones.new(name)
        bone.head = to_blender(point)
        bone.tail = to_blender(point + Vector((0, 0.05, 0)))
        if parent is not None:
            bone.parent = armature.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


NECK_SEAM_Y = 1.45
HEAD_DEPTH_OFFSET = 0.005
# The selected elliptical silhouette. Height, half-width, front and back radii,
# and center depth are in millimeters, measured from the neck seam.
HEAD_SECTIONS = [
    (-36, 70, 56, 54, -4),
    (-18, 54, 52, 46, -1),
    (0, 51, 52, 44, 1),
    (24, 54, 67, 49, 1),
    (48, 62, 82, 59, -1),
    (81, 69, 84, 70, -3),
    (123, 74, 83, 82, -3),
    (160, 75, 80, 85, -3),
    (193, 70, 69, 74, -2),
    (220, 58, 54, 59, -2),
    (242, 39, 36, 39, -2),
    (250, 0, 0, 0, -2),
]


def blend_weights(first, second, amount):
    combined = dict.fromkeys(first.keys() | second.keys())
    for bone in combined:
        combined[bone] = (1 - amount) * first.get(bone, 0) + amount * second.get(bone, 0)
    retained = sorted(combined.items(), key=lambda pair: (-pair[1], pair[0]))[:4]
    total = sum(value for _, value in retained)
    return {bone: value / total for bone, value in retained if value > 0}


def clip_at_neck(points, faces, weights):
    """Cut through the fitted neck and recover the ordered shared boundary."""
    intersections = {}
    seam_vertices = set()
    clipped = []
    boundary = {}
    for face in faces:
        polygon = []
        for a, b in zip(face, face[1:] + face[:1]):
            start, end = points[a], points[b]
            keep_start, keep_end = start.y < NECK_SEAM_Y, end.y < NECK_SEAM_Y
            if keep_start:
                polygon.append(a)
            if keep_start == keep_end:
                continue
            edge = tuple(sorted((a, b)))
            if edge not in intersections:
                amount = (NECK_SEAM_Y - start.y) / (end.y - start.y)
                point = start.lerp(end, amount)
                point.y = NECK_SEAM_Y
                intersections[edge] = len(points)
                seam_vertices.add(len(points))
                points.append(point)
                weights.append(blend_weights(weights[a], weights[b], amount))
            polygon.append(intersections[edge])
        if len(polygon) >= 3:
            clipped.append(polygon)
            for a, b in zip(polygon, polygon[1:] + polygon[:1]):
                if a in seam_vertices and b in seam_vertices:
                    # Reverse the shared edge to get the outward winding of the loft.
                    boundary[b] = a

    if not boundary or set(boundary) != set(boundary.values()):
        raise ValueError("Expected a single closed neck seam")
    first = min(boundary)
    ring = [first]
    while boundary[ring[-1]] != first and len(ring) < len(boundary):
        ring.append(boundary[ring[-1]])
    if len(ring) != len(boundary) or len(set(ring)) != len(ring):
        raise ValueError("Expected a single closed neck seam")
    return clipped, ring


def loft_head(points, faces, weights, seam):
    # Interpolate the squared radii so the last rings approach a rounded pole.
    profiles = [
        HeightProfile([(row[0], row[column] ** 2 if column <= 3 else row[column])
                       for row in HEAD_SECTIONS])
        for column in range(1, 5)
    ]

    def section(height, angle):
        width, front, rear, depth = (profile(height) for profile in profiles)
        axial = cos(angle)
        return Vector((0.001 * sqrt(max(0, width)) * sin(angle),
                       NECK_SEAM_Y + height * 0.001,
                       HEAD_DEPTH_OFFSET + 0.001 * (depth + sqrt(max(0, front if axial >= 0 else rear)) * axial)))

    center = HEAD_DEPTH_OFFSET + 0.001

    def angle_of(point):
        radius = 0.052 if point.z >= center else 0.044
        return atan2(point.x / 0.051, (point.z - center) / radius)

    angles = [angle_of(points[index]) for index in seam]
    offsets = [points[index] - section(0, angle) for index, angle in zip(seam, angles)]
    head_weights = {"head": 1.0}
    lower = seam
    for i in range(1, 60):
        height = 125 * (1 - cos(pi * i / 60))
        transition = 1 - smoothstep(0, 24, height)
        skin = smoothstep(0, 96, height)
        upper = []
        for angle, offset, index in zip(angles, offsets, seam):
            upper.append(len(points))
            points.append(section(height, angle) + transition * offset)
            weights.append(blend_weights(weights[index], head_weights, skin))
        for j, a in enumerate(lower):
            k = (j + 1) % len(lower)
            faces.append([a, lower[k], upper[k], upper[j]])
        lower = upper
    crown = len(points)
    points.append(section(250, 0))
    weights.append(head_weights)
    for j, index in enumerate(lower):
        faces.append([index, lower[(j + 1) % len(lower)], crown])


def create_surface(vertices, faces, joints, weights, fit, armature):
    indices = sorted({index for face in faces for index in face})
    lookup = {source: index for index, source in enumerate(indices)}
    points = [fit(vertices[source], weights[source]) for source in indices]
    surface_weights = [weights[source] or {"pelvis": 1} for source in indices]
    faces = [[lookup[index] for index in face] for face in faces]
    faces, seam = clip_at_neck(points, faces, surface_weights)
    loft_head(points, faces, surface_weights, seam)

    retained = sorted({index for face in faces for index in face})
    vertex_map = {old: new for new, old in enumerate(retained)}
    mesh = bpy.data.meshes.new("Human Surface")
    mesh.from_pydata([to_blender(points[index]) for index in retained], [],
                     [[vertex_map[index] for index in face] for face in faces])
    mesh.validate()
    mesh.update()
    surface = bpy.data.objects.new("Human Surface", mesh)
    bpy.context.collection.objects.link(surface)
    for face in mesh.polygons:
        face.use_smooth = True

    for name in joints:
        surface.vertex_groups.new(name=name)
    for index, point_index in enumerate(retained):
        for name, value in surface_weights[point_index].items():
            surface.vertex_groups[name].add([index], value, "REPLACE")

    # Soften localized details for an untextured teaching mannequin.
    smoothing = surface.vertex_groups.new(name="Surface finish")
    for index, point_index in enumerate(retained):
        point = points[point_index]
        neck = (smoothstep(1.429, 1.445, point.y)
                * (1 - smoothstep(1.452, 1.472, point.y))
                * (1 - smoothstep(0.055, 0.082, abs(point.x))))
        if neck > 0.001:
            smoothing.add([index], neck, "REPLACE")
        if point_index >= len(indices):
            continue
        x, y, z = vertices[indices[point_index]]
        pelvis = (1 - smoothstep(0.12, 0.40, abs(x))) * smoothstep(0.56, 0.96, z)
        pelvis *= smoothstep(-0.92, -0.48, y) * (1 - smoothstep(0.07, 0.56, y))
        if pelvis > 0.001:
            smoothing.add([index], pelvis, "REPLACE")
    bpy.context.view_layer.objects.active = surface
    finish = surface.modifiers.new("Surface finish", "SMOOTH")
    finish.vertex_group = smoothing.name
    finish.factor = 0.64
    finish.iterations = 5
    bpy.ops.object.modifier_apply(modifier=finish.name)
    surface.vertex_groups.remove(surface.vertex_groups["Surface finish"])

    surface.parent = armature
    modifier = surface.modifiers.new("HumanRig", "ARMATURE")
    modifier.object = armature
    return surface


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mesh", type=Path)
    parser.add_argument("skeleton", type=Path)
    parser.add_argument("weights", type=Path)
    parser.add_argument("output", type=Path)
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    args = parser.parse_args(argv)

    vertices, faces = read_body(args.mesh)
    if not faces:
        raise ValueError("The MakeHuman OBJ has no body group")
    skeleton = json.loads(args.skeleton.read_text(encoding="utf-8"))
    source_weights = json.loads(args.weights.read_text(encoding="utf-8"))["weights"]
    landmarks = source_landmarks(skeleton, vertices)
    joints = human_rig()
    fit = BodyFit(landmarks, joints)
    weights = remap_weights(source_weights, len(vertices))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    armature = create_armature(joints)
    create_surface(vertices, faces, joints, weights, fit, armature)
    bpy.ops.export_scene.gltf(filepath=str(args.output), export_format="GLB",
                              export_materials="NONE", export_texcoords=False,
                              export_normals=True, export_animations=False, export_skins=True,
                              export_yup=True)
    fit_exported_torso(args.output)


if __name__ == "__main__":
    main()

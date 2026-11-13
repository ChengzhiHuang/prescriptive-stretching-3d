"""Apply the selected torso shape to the exported skinned GLB in bind coordinates."""

import json
import math
import struct


WIDTH_PROFILE = (
    (0.840, 1.000), (0.950, 0.860), (1.025, 0.890), (1.096, 0.970),
    (1.155, 1.030), (1.220, 1.045), (1.290, 1.072), (1.350, 1.048), (1.430, 1.008),
)
TRUNK_JOINTS = ("pelvis", "lumbar", "thoracic", "clavicleL", "clavicleR")
SHOULDER_JOINTS = ("shoulderL", "shoulderR")
COMPONENT_FORMATS = {5121: "B", 5123: "H", 5125: "I", 5126: "f"}
ACCESSOR_WIDTHS = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}
GLB_MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def smoothstep(low, high, value):
    amount = min(1, max(0, (value - low) / (high - low)))
    return amount * amount * (3 - 2 * amount)


def torso_width(height):
    for (low, narrow), (high, wide) in zip(WIDTH_PROFILE, WIDTH_PROFILE[1:]):
        if height <= high:
            return narrow + (wide - narrow) * smoothstep(low, high, height)
    return WIDTH_PROFILE[-1][1]


def fit_vertex(point, weights):
    x, y, z = point
    side = abs(x)
    trunk_weight = sum(weights.get(name, 0) for name in TRUNK_JOINTS)
    shoulder_weight = sum(weights.get(name, 0) for name in SHOULDER_JOINTS)
    shoulder_blend = smoothstep(1.18, 1.35, y) * (1 - smoothstep(1.395, 1.429, y))
    torso_weight = min(1, trunk_weight + 0.85 * shoulder_weight * shoulder_blend)
    influence = torso_weight * (smoothstep(0.826, 0.94, y) * (1 - smoothstep(1.365, 1.444, y)))
    if influence < 1e-10:
        return point

    # Shape the chest as one shallow curve and fade it into the ribs, neck and arm.
    chest_center = 0.122 - 0.56 * (y - 1.245) ** 2 - 0.57 * max(0, y - 1.30) ** 1.62
    chest_depth = chest_center - 0.019 * (side / 0.14) ** 2
    chest_blend = smoothstep(1.085, 1.16, y) * (1 - smoothstep(1.35, 1.419, y))
    chest_blend *= (1 - smoothstep(0.122, 0.181, side)) * smoothstep(0.028, 0.082, z)
    abdomen = smoothstep(0.98, 1.06, y) * (1 - smoothstep(1.11, 1.175, y)) * smoothstep(0.022, 0.10, z)
    depth = 0.95 * chest_blend * (chest_depth - z) - 0.007 * abdomen

    shoulder_slope = smoothstep(0.10, 0.212, side) * smoothstep(1.29, 1.385, y) * (1 - smoothstep(1.402, 1.442, y))
    waist_length = smoothstep(0.90, 1.0, y) * (1 - smoothstep(1.03, 1.2, y))
    return (
        x * (1 + influence * (torso_width(y) - 1)),
        y - influence * (0.012 * waist_length + 0.021 * shoulder_slope),
        z + influence * depth,
    )


def difference(first, second):
    return [a - b for a, b in zip(first, second)]


def fitted_normals(original, fitted, normals, faces):
    moved = {index for index, (old, new) in enumerate(zip(original, fitted)) if math.dist(old, new) > 1e-9}
    affected = {index for face in faces if moved.intersection(face) for index in face}
    accumulated = {index: [0.0, 0.0, 0.0] for index in affected}
    for a, b, c in faces:
        if not affected.intersection((a, b, c)):
            continue
        ux, uy, uz = difference(fitted[b], fitted[a])
        vx, vy, vz = difference(fitted[c], fitted[a])
        cross = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        area = math.hypot(*cross)
        if area < 1e-14:
            continue
        for vertex, first, second in ((a, b, c), (b, c, a), (c, a, b)):
            if vertex not in affected:
                continue
            incoming = difference(fitted[first], fitted[vertex])
            outgoing = difference(fitted[second], fitted[vertex])
            angle = math.atan2(area, sum(u * v for u, v in zip(incoming, outgoing)))
            for axis in range(3):
                accumulated[vertex][axis] += angle * cross[axis] / area
    result = list(normals)
    for index, normal in accumulated.items():
        length = math.hypot(*normal)
        if length > 1e-9:
            result[index] = [value / length for value in normal]
    return result


def fit_exported_torso(path):
    """Refit vertices and neighboring normals without changing GLB topology or weights."""
    data = path.read_bytes()
    magic, version, size, json_size, json_type = struct.unpack_from("<5I", data)
    binary_start = 20 + json_size
    binary_size, binary_type = struct.unpack_from("<2I", data, binary_start)
    if (magic, version, size, json_type, binary_type, binary_start + 8 + binary_size) != (
        GLB_MAGIC, 2, len(data), JSON_CHUNK, BIN_CHUNK, len(data)
    ):
        raise ValueError("Expected one Blender GLB with a JSON chunk and a binary chunk")
    asset = json.loads(data[20:binary_start])
    binary = bytearray(data[binary_start + 8:])
    mesh, = asset["meshes"]
    primitive, = mesh["primitives"]
    skin, = asset["skins"]
    joints = [asset["nodes"][index]["name"] for index in skin["joints"]]

    def accessor(index):
        info = asset["accessors"][index]
        view = asset["bufferViews"][info["bufferView"]]
        offset = view.get("byteOffset", 0) + info.get("byteOffset", 0)
        encoding = struct.Struct("<" + COMPONENT_FORMATS[info["componentType"]] * ACCESSOR_WIDTHS[info["type"]])
        return info, offset, encoding, view.get("byteStride", encoding.size)

    def read(index):
        info, offset, encoding, stride = accessor(index)
        return [encoding.unpack_from(binary, offset + row * stride) for row in range(info["count"])]

    def write(index, rows):
        info, offset, encoding, stride = accessor(index)
        for row, values in enumerate(rows):
            encoding.pack_into(binary, offset + row * stride, *values)
        for key, bound in (("min", min), ("max", max)):
            if key in info:
                info[key] = [bound(column) for column in zip(*rows)]

    attributes = primitive["attributes"]
    positions = read(attributes["POSITION"])
    normals = read(attributes["NORMAL"])
    skin_joints = read(attributes["JOINTS_0"])
    skin_weights = read(attributes["WEIGHTS_0"])
    fitted = [
        fit_vertex(point, {joints[joint]: weight for joint, weight in zip(indices, weights) if weight})
        for point, indices, weights in zip(positions, skin_joints, skin_weights)
    ]
    index_rows = [row[0] for row in read(primitive["indices"])]
    faces = list(zip(index_rows[::3], index_rows[1::3], index_rows[2::3]))
    write(attributes["POSITION"], fitted)
    write(attributes["NORMAL"], fitted_normals(positions, fitted, normals, faces))

    metadata = json.dumps(asset, separators=(",", ":")).encode()
    metadata += b" " * (-len(metadata) % 4)
    header = struct.pack("<5I", GLB_MAGIC, 2, 28 + len(metadata) + len(binary), len(metadata), JSON_CHUNK)
    path.write_bytes(header + metadata + struct.pack("<2I", len(binary), BIN_CHUNK) + binary)

# 人体网格

`human.glb` 基于 MakeHuman 的 hm08 核心人体网格、默认骨骼地标和原始蒙皮权重。底模来自 Data Collection AB、Joel Palmius 和 Jonas Hauquier。三份源素材都使用 CC0 1.0。 [MakeHuman 素材许可](https://github.com/makehumancommunity/makehuman/blob/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/LICENSE.md#c-the-license-for-the-bundled-assets)

素材锁定到 MakeHuman 提交 `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`。在 Blender 4.5.16 LTS 中保留连续人体表面，按现有关节重新拟合四肢和体态，将原始权重归并到现有的 20 个命名关节。头部按自然椭圆轮廓生成，通过共享顶点与原有颈部接合，并沿颈部过渡到头部关节的权重。导出的模型以米为单位，Y 轴向上，Z 轴向前，由现有动作驱动。模型包含 11,901 个顶点和 23,798 个三角形。

躯干采用已选定的修长成年男性比例。导出脚本会调整肩线、胸廓、腰腹和髋部曲线，并根据更新后的三角面重算法线。骨架和蒙皮权重沿用底模。

从仓库根目录运行以下命令可重新导出模型。应用运行时直接读取本地 GLB。

```sh
asset_dir="$(mktemp -d)"
makehuman="https://raw.githubusercontent.com/makehumancommunity/makehuman/a8bc2d54ff0ac92e78ff71431b1023eda42bf482/makehuman/data"
curl -fsSL "$makehuman/3dobjs/base.obj" -o "$asset_dir/base.obj"
curl -fsSL "$makehuman/rigs/default.mhskel" -o "$asset_dir/default.mhskel"
curl -fsSL "$makehuman/rigs/default_weights.mhw" -o "$asset_dir/default_weights.mhw"
blender --background --factory-startup --python-exit-code 1 \
  --python web/scripts/build_human_glb.py -- \
  "$asset_dir/base.obj" "$asset_dir/default.mhskel" "$asset_dir/default_weights.mhw" \
  web/src/assets/human.glb
```

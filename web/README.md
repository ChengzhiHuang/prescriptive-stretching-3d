# Web 3D 动态人体解剖伴读前端（`web/`）

本目录为《精准拉伸》纯 3D 动态人体解剖伴读系统的前端工程（Vite + TypeScript + Three.js，零后端依赖，不含任何 PDF 阅读组件或原书文本），内置全书 **40 个拉伸动作**三维骨骼肌束模型与 **14 套疼痛缓解处方**导览。

在线预览：<https://chengzhihuang.github.io/prescriptive-stretching-3d/>

支持桌面端宽屏三栏工作台与手机端竖屏 / 横屏自适应跟练视图（触控旋转缩放、四阶段实时读秒、疼痛处方快捷切换及正误代偿对比）。完整功能与使用说明请见仓库根目录 [`../README.md`](../README.md)。

## 常用脚本

```sh
npm install       # 安装依赖
npm run dev       # 启动本地开发服务器 (http://127.0.0.1:5173/)
npm run validate  # 校验全部 40 个 3D 动作骨骼插槽与生物力学拉伸率
npm run build     # TypeScript 类型检查并构建静态站点至 dist/
npm run preview   # 本地预览生产构建产物 (http://127.0.0.1:4173/)
```

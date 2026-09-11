<div align="center">

# 🍄 超级马力欧关卡编辑器

**在浏览器中制作属于你自己的 SMB1 风格关卡 — 即做即玩,用文件分享**

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

[![Bun](https://img.shields.io/badge/Bun-1.4-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org)
[![运行时依赖](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](#-技术栈)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![关卡编辑器](docs/screenshots/editor.png)

</div>

---

## ✨ 特性

<table>
<tr>
<td width="50%">

### 🖌️ 完整的关卡编辑器
- 绘制 · 擦除 · 矩形填充 · 选择/移动/复制/粘贴
- 以操作为单位的撤销/重做(最多 200 步)
- 1x–8x 以指针为中心的缩放 · 平移 · 16px 网格吸附
- 分类元件面板 + 已放置对象的**属性检查器**
- 出生点 · 旗杆终点 · 城堡终点 · 联动水管 / 传送区
- 可创建并连接多个区域(地上 ↔ 地下等)

</td>
<td width="50%">

### 🎮 真正可以玩的游戏
- 奔跑 · 可变高度跳跃 · 下蹲 · 游泳 · 攀藤
- 小人 → 超级 → 火焰形态、无敌星、1UP
- 踩踏 · 龟壳连击 · 火球战斗
- 金币 · 分数 · 生命 · 计时 · 旗杆/斧头结局
- 编辑 ↔ 试玩即时切换(编辑内容完整还原)

</td>
</tr>
<tr>
<td>

### 🗺️ 4 种主题 · 完整 SMB1 阵容
- **地上 · 地下 · 水下 · 城堡**
- 栗宝宝、绿/红诺库龟与帕拉龟、食人花、钢盔龟、炮台/子弹比尔、锤子兄弟、球盖姆、泡泡鱼/鱿鱼、岩浆泡、火焰棒、库巴 + 斧头桥
- 移动/坠落/跷跷板平台、弹簧、隐藏砖块、藤蔓

</td>
<td>

### 💾 本地优先存储
- IndexedDB **自动保存** + 版本冲突检测
- 关卡收藏库:打开/重命名/复制/删除
- `.smb1.json` **导出/导入** — 经过完整校验的可移植格式
- 无需账号 · 无服务器 · 免安装

</td>
</tr>
</table>

🎵 芯片音乐原声(各主题 BGM + 音效)由 Web Audio 实时合成。

> **诚实范围说明** — 没有账号、没有在线公开目录、没有服务器、没有多人模式、没有移动端编辑器。浏览器 IndexedDB 自动保存**并非永久备份**:清除站点数据、存储空间被回收或更换浏览器配置文件都会丢失——可靠的备份是**导出**的 JSON 文件。不承诺与原作 bug 或逐帧时序完全一致。

---

## 📸 截图

<div align="center">
<img src="docs/screenshots/library.png" width="720" alt="关卡收藏库">
<p><sub>关卡收藏库 — 新建 · 打开 · 重命名 · 复制 · 删除</sub></p>

<table>
<tr>
<td><img src="docs/screenshots/play-overworld.png" alt="地上主题试玩"></td>
<td><img src="docs/screenshots/play-underground.png" alt="地下主题试玩"></td>
</tr>
<tr>
<td><img src="docs/screenshots/play-underwater.png" alt="水下主题试玩"></td>
<td><img src="docs/screenshots/play-castle.png" alt="城堡主题试玩"></td>
</tr>
</table>
<p><sub>地上 · 地下 · 水下 · 城堡 — 四种主题实机画面</sub></p>

<img src="docs/screenshots/playtest.png" width="720" alt="试玩浮层">
<p><sub>在编辑器内直接试玩 — 分数 · 金币 · 生命 · 时间 HUD</sub></p>

<img src="docs/screenshots/sprites.png" width="720" alt="像素素材库">
<p><sub>113 帧 · 4 套主题调色板 — 全部为仓库内原创像素画</sub></p>
</div>

---

## 🚀 快速开始

只需要 [Bun](https://bun.sh) 1.4+。(零运行时依赖)

```bash
bun install        # 安装开发依赖
bun run dev        # 开发服务器 (http://127.0.0.1:4173)
```

构建并预览:

```bash
bun run build      # 输出浏览器包到 dist/
bun run preview    # 托管 dist (http://127.0.0.1:4173)
```

打开 `http://127.0.0.1:4173`,依次点击 **새 코스 만들기**(新建关卡)→ **작업실 열기**(打开工作间)→ **▶ 플레이**(游玩)。

> 💡 四个示例关卡(`솔바람 능선` · `등잔 굴` · `청파 수로` · `불씨 성`)位于 `src/level/samples.ts`。将其序列化为 `.smb1.json` 后,通过编辑器工具栏的 **가져오기**(导入)打开——收藏库首页没有文件选择入口。

详细操作说明见 [`docs/controls.md`](docs/controls.md),文件格式见 [`docs/format.md`](docs/format.md),素材与音乐来源见 [`docs/assets.md`](docs/assets.md)。应用界面为韩语。

## 🕹️ 操作方式

| 游玩 | 按键 |
| --- | --- |
| 移动 | `←` `→` 或 `A` `D` |
| 跳跃 / 游泳 | `Space` 或 `Z` |
| 奔跑 / 火球 | `Shift` 或 `X` |
| 下蹲 / 进入水管 | `↓` 或 `S` |
| 攀爬藤蔓 | `↑` |
| 暂停 | `Esc` |

| 编辑器 | 按键 / 操作 |
| --- | --- |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y` |
| 复制 / 粘贴 / 删除 | `Ctrl+C` / `Ctrl+V` / `Delete` |
| 取消选择 | `Esc` |
| 平移视图 | 中键拖动或 `Space`+拖动 |
| 缩放 | `1x`–`8x` 按钮(以指针为锚点) |

## 🗂️ 关卡文件格式

关卡以 `.smb1.json` 扩展名导出/导入,是**带版本的 JSON 文档**(`format: "smb1-maker", version: 1`)。

- 稀疏瓦片图 + 带坐标和类型化属性的放置对象列表
- 交叉引用(水管目的地、跷跷板配对、传送区槽位)做双向校验
- 最大 32 MiB、16 个区域——导入是原子操作:失败不会覆盖已打开的关卡
- 非法 JSON/版本/引用会以具体错误码拒绝(`malformed_json`、`invalid_reference` 等)

## 🧱 技术栈

| 领域 | 选型 |
| --- | --- |
| 语言 | TypeScript(`strict`、`noUncheckedIndexedAccess`) |
| 渲染 | Canvas 2D — 256×240 逻辑分辨率,像素完美缩放 |
| 模拟 | 固定 60Hz 步进,确定性,不依赖 DOM(`src/game`) |
| 音频 | Web Audio API 实时芯片音乐合成 |
| 存储 | IndexedDB 事务式自动保存 + 文件导入/导出 |
| 工具链 | Bun(开发/构建/测试)· Biome · Playwright 真实浏览器 QA |
| 运行时依赖 | **无** — 纯 DOM + Canvas,无游戏/UI 框架 |

```
src/
├── game/       固定步进模拟(物理·碰撞·敌人·道具·终点)
├── editor/     编辑命令 · 历史 · 绘制 · 选择 · 区域
├── level/      关卡模式 · 校验 · 序列化 · 目录 · 示例
├── render/     像素画集 · 场景渲染器
├── audio/      芯片音乐调度器 · 乐器 · 音效
├── storage/    IndexedDB · 自动保存 · 收藏库 · 文件
└── ui/         收藏库 · 编辑器 · 检查器 · HUD
```

## ✅ 开发

```bash
bun test               # 单元/集成测试(27 个套件)
bun run typecheck      # tsc --noEmit
bun run diagnostics    # 代码诊断
bun run qa --scenario all --evidence <dir>   # 真实浏览器 QA 场景
bun run scripts/screenshots.ts               # 重新生成本 README 的截图
```

所有截图均来自真实构建产物。重新生成方法:先运行 `bun run preview`,再执行上面的脚本(可用 `PREVIEW_ORIGIN` 指定地址)。

## 📜 许可证

[MIT](LICENSE) — 涵盖代码以及本仓库中原创的像素画/音乐数据。

> ⚠️ 本项目为非官方粉丝作品,与任天堂无关。*超级马力欧兄弟*(Super Mario Bros.)相关名称与角色的全部权利归任天堂所有;本仓库中的精灵与音乐为**原创重制**,未复制任何 ROM 或原始素材。不建议用于商业用途。

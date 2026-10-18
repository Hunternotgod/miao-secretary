# 🐱 喵秘书 (MiaoSecretary)

## :link: 版本下载

- **最新版 v2.1.0（稳定版）**：[下载最新版](https://gitee.com/fat-cat-barbecue/miao-secretary/releases/download/v2.1.0/miao-secretary_2.1.0_x64-setup.exe)

历史版本请见 [Releases](https://gitee.com/fat-cat-barbecue/miao-secretary/releases)。

> **微信群消息 → 智能整理 → 微信消息** —— 群聊不再刷屏，关键信息一条不漏。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-blue)](https://gitee.com/fat-cat-barbecue/miao-secretary)
[![Version](https://img.shields.io/badge/Version-2.1.0%20stable-green)](https://gitee.com/fat-cat-barbecue/miao-secretary/releases)

## 这是什么
![喵秘书](docs/tupian.png)

喵秘书是一款桌面应用，帮 PC 微信用户把群消息整理成清晰的「整理结果」：

- 📝 **AI 整理群消息** —— 自动提取重点、待办和关键信息
- ⏰ **关键信息自动提取** —— 时间 / 地点 / 截止日期 / 链接，结构化呈现
- 📚 **整理结果集中查看** —— 所有群的整理结果统一管理，可检索可回看
- 🔁 **自动同步** —— 新消息自动同步，也可以手动立即同步
- 🛡️ **微信记录仅本机读取** —— 分析时只把消息文本发送给你选择的 AI 服务

> **核心场景**：班级群通知、社团活动、课程变更、招聘推送 —— 这些「不看会死，看了又烦」的消息，喵秘书替你筛。

## v2.1.0 最新版更新

- 今日必看与微信消息的待办 / 完成 / 待回复标记实时绑定；
- 微信消息把「已标记待回复」和「AI 建议回复」分栏，计数与今日必看对齐；
- AI 建议、@我和普通话题留在微信消息，不直接进入今日必看；
- 微信消息单会话话题按日分组，默认只展开今天，其他日期和更早话题收起分页；
- 锁定事件的变更先确认，不再自动改写标题、时间、地点和提醒；
- 今日必看增加筛选、批量完成/忽略、最近处理和标题纠正；
- 修复确认框、诊断导出、侧车端口和 WebView2 恢复问题；
- AI API Key 迁移到 Windows 凭据管理器；
- 历史数据支持按 30/90/180 天手动清理。

> v2.1.0 为当前最新版，也是推荐使用的稳定版。

## 微信连接说明（重要）

- 本仓库公开的是**可开源的部分**：桌面 UI、AI 服务适配、整理结果、自动同步与设置等。
- **PC 微信本地聊天记录的读取通道是闭源组件**，不包含在本仓库中，本仓库也不会提供其实现细节或相关文档。
- 官方发布的 Windows 安装包内置该通道，可直接从 [Releases](https://gitee.com/fat-cat-barbecue/miao-secretary/releases) 下载体验完整功能。
- 从源码自行构建时，微信连接会显示「不可用 / 未连接」；其余功能（AI 配置、微信消息等）不受影响。

##  :santa:  图片展示

![1](docs/1.png)
![2](docs/2.png)
![3](docs/3.png)
![4](docs/4.png)
![5](docs/5.png)
![6](docs/6.png)
![7](docs/7.png)

## 🚀 从源码开发

### 环境要求

- Node.js ≥ 20
- pnpm ≥ 9
- Rust ≥ 1.77

### 步骤

```bash
# 1. 克隆仓库
git clone https://gitee.com/fat-cat-barbecue/miao-secretary.git
cd miao-secretary

# 2. 安装依赖
pnpm install

# 3. 前端开发模式(Vite)
pnpm dev

# 4. Tauri 桌面开发模式
pnpm tauri:dev

# 5. 打包
pnpm tauri:build
```

> 说明：微信数据通道为闭源组件，需要完整功能请使用官方发布版安装包。

## 🧠 AI 配置

应用支持任意 **OpenAI 兼容协议** 的 API。出厂预设的 provider：

| 服务 | 价格 | 备注 |
|---|---|---|
| **智谱 GLM-4-Flash** | 新用户免费额度 | 国内手机号即注册，推荐首选 |
| **DeepSeek** | 充值制，1 元能用很久 | 中文强、便宜 |
| **MiniMax** | 新用户免费额度 | 支持 1M 上下文 |
| **Google Gemini 2.0 Flash** | 新用户免费额度 | OpenAI 兼容，速度快 |
| **OpenAI** | 按量 | 贵但稳 |
| **月之暗面 Kimi** | 充值制 | 长上下文 |
| **硅基流动** | 充值制 | 模型丰富 |
| **本地 Ollama** | 完全免费 | 需装 Ollama |

> 模型名以官网最新列表为准。应用界面每个 provider 旁都有「查看可用模型」链接。

## 📂 项目结构

```
miao-secretary/
├── src/                       # React 前端
│   ├── components/            # UI 组件
│   ├── lib/                   # AI 适配 / 数据存储 / 监控调度
│   ├── pages/                 # 页面(时间线 / 监控 / 设置 / 数据源)
│   ├── assets/                # 应用图标等资源
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/                 # Tauri 桌面壳(Rust)
│   ├── icons/                 # 应用图标(png / ico / icns)
│   ├── src/                   # Rust 命令与 sidecar 启动
│   └── tauri.conf.json
├── docs/
│   └── landing.html           # 产品介绍页(静态单页)
└── README.md                  # 你正在看这个
```

## 🏗️ 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | [Tauri 2.0](https://tauri.app/) (Rust + WebView) |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS |
| AI | OpenAI 兼容协议(智谱 / DeepSeek / MiniMax / Google / OpenAI / Kimi / SiliconFlow / Ollama / 自定义) |
| 本地存储 | IndexedDB(Dexie) + Tauri SQLite 插件 |

## 🤝 贡献与反馈

欢迎在 [Issues](https://gitee.com/fat-cat-barbecue/miao-secretary/issues) 提交反馈，或直接发起 PR：

1. Fork 仓库
2. 创建 feature 分支(`git checkout -b feature/amazing-feature`)
3. 提交改动(`git commit -m 'feat: add amazing feature'`)
4. 推送分支(`git push origin feature/amazing-feature`)
5. 创建 Pull Request

> 注意：涉及 PC 微信本地数据读取通道的代码不在本仓库，相关 PR 不会被合并。

## 📜 License

- 本仓库代码基于 **MIT License** 开源，详见 [LICENSE](LICENSE)。
- PC 微信本地数据读取通道为**闭源专有组件**，仅随官方发布版提供，不适用本开源协议。

## ⚠️ 免责声明

- 请只整理、使用你**自己有权限访问**的聊天内容，遵守所在地法律法规与微信服务条款。
- 本软件不收集、不上传任何个人数据；AI 分析仅在你配置的 AI 服务上进行。

## 请肥猫叉烧喝杯奶茶
![输入图片说明](%E5%BC%80%E6%BA%90%E9%A1%B9%E7%9B%AE%E6%89%93%E8%B5%8F%E6%94%B6%E6%AC%BE.jpg)

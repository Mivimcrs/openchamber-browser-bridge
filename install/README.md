# 安装

两条路，任选一条。装完都要**完全退出 OpenChamber 再启动**。

## A. 一键脚本（Windows，推荐给新电脑）

```powershell
git clone https://github.com/Mivimcrs/openchamber-browser-bridge.git
cd openchamber-browser-bridge
powershell -ExecutionPolicy Bypass -File install\install.ps1
```

脚本只做四件事，不动其它扩展：

1. 复制扩展包到 `<配置目录>\extensions\browser-bridge`；
2. 在 `extensions.json` 的 `paths` 里登记/替换 browser-bridge 路径；
3. 把 `settings.json` 的 `browserProvider` 设为 `browser-bridge`；
4. 自检版本、service 入口、默认浏览器，并打印后续步骤。

参数：

| 参数 | 说明 |
| --- | --- |
| `-ConfigDir <path>` | OpenChamber 配置目录，默认 `~/.config/openchamber` |
| `-Source <path>` | 要安装的包根，默认脚本上一级（仓库根） |
| `-Grant` | 预写 `service` / `opencodePlugin` / `skills` 授权，跳过首次批准弹窗 |

没有 `-Grant` 时，重开 OpenChamber 会弹一次权限批准，点允许即可。

## B. 在 OpenChamber 里装

设置 → 扩展 → 添加扩展，选仓库根目录（或 Release 的 zip），批准权限；再去
设置 → 通用 → OpenChamber 工具 → 浏览器提供者 → 选「OpenChamber-Browser-bridge」。

## 另一台电脑还缺什么

| 需要 | 说明 |
| --- | --- |
| OpenChamber ≥ 2.7.0 | 扩展引擎版本要求 |
| 一个 Chromium 内核浏览器 | 默认按 ungoogled-chromium → Chrome → Edge → Vivaldi 探测；都没有就在面板里填 exe 路径 |
| 不需要浏览器侧扩展 | 本桥自己拉起 Chromium，不用在浏览器里「加载已解压」 |

## 验证装好了

1. 扩展列表里出现「OpenChamber-Browser-bridge」，权限已批准；
2. 设置里的浏览器提供者是它；
3. 对话里让 agent 打开一个页面：它会先问你是否允许，同意后浏览器窗口自动出现。

## 卸载

```powershell
Remove-Item -Recurse -Force "$HOME\.config\openchamber\extensions\browser-bridge"
```

再删 `extensions.json` 的 `paths` 里对应项，`browserProvider` 改回 `builtin`
（或重开 OpenChamber，它会在扩展缺失时自动回退）。

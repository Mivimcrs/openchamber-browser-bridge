# 一键安装（Windows）

```powershell
git clone https://github.com/Mivimcrs/openchamber-browser-bridge.git
cd openchamber-browser-bridge
powershell -ExecutionPolicy Bypass -File install\install.ps1
```

然后**完全退出并重开 OpenChamber**。首次会弹权限批准（service / opencodePlugin /
skills），点允许；浏览器提供者脚本已经帮你设好。

如需跳过批准弹窗（自用、已知内容）加 `-Grant`：

```powershell
powershell -ExecutionPolicy Bypass -File install\install.ps1 -Grant
```

详细说明见 [`install/README.md`](install/README.md)。

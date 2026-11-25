# 测试

## 单元测试

```bash
npm test
```

覆盖：

- `tests/browser-provider.test.mjs`：授权门响应、动作白名单、错误文案；
- `tests/state.test.mjs`：设置读写、默认浏览器探测、授权 TTL。

## 冒烟测试（会真的拉起浏览器）

```bash
npm run smoke          # 用 service/main.js
npm run smoke:bundle   # 用打包后的 service/bundle.js（发布入口）
```

两者都不依赖 OpenChamber 宿主：自己起服务进程、用临时数据目录、直接 POST
`/browser-control`，断言：

- `/health` 就绪、无 token 401；
- 未授权时动作被拒且提示可执行；
- 授权后 `browser.open` 真的拉起浏览器并返回 tabId；
- `snapshot` 有正文与元素、`tabs` 有标签；
- 撤销授权后再次被拒。

测试数据写在 `tmp-test-data/`，跑完可直接删。

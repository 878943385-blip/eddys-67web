# Eddy's 67web · 真心话大冒险（多人联机网页版）

纯静态部署的多人联机真心话大冒险游戏，托管在 GitHub Pages，无需任何后端服务器。

🔗 **在线游玩**：https://rockeyld.github.io/eddys-67web/

## 玩法

1. **创建/加入房间**：创建时选择房间最大人数（2-12 人），生成 4 位房间号；朋友输入房间号加入
2. **猜拳定胜负**：每轮 10 秒倒计时出石头/剪刀/布，超时自动判输；全员同意可重开本局；三家全出或同拳自动平局重开
3. **随机出题**：猜拳输家随机一人为回答者，另一名玩家随机成为出题人；出题人可选真心话/大冒险，自拟题目或从题库（各 30 道）抽取
4. **全员聊天**：题目公布后所有人可以在聊天区发言互动

## 架构：房主即服务器（Peer-hosted）

GitHub Pages 只能托管静态文件，无法运行 Node 后端。本作的多人联机通过以下方式实现：

- **权威引擎在房主浏览器**：创建房间的人的页面运行 `game-core.js` 完整游戏状态机（倒计时、猜拳结算、出题、聊天全部由房主裁决）
- **MQTT over WebSocket 中转**：所有消息经公共 MQTT broker（EMQX / HiveMQ / Mosquitto，自动故障转移）转发
  - `tod67web/<房间号>/state` — 房间快照（retained，新玩家加入立即同步）
  - `tod67web/<房间号>/action` — 玩家动作
  - `tod67web/<房间号>/chat` — 聊天与定向错误
  - `tod67web/<房间号>/presence/<id>` — 心跳，房主 12 秒收不到即判定掉线
- **限制**：房主中途关闭页面会导致房间解散（页面有提示）；刷新页面的玩家会以新身份重新加入

## 本地开发

直接用任意静态服务器托管本目录即可：

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

> 注意：MQTT 走的是公共 broker 的 WSS 端口，`file://` 直开也可以联机，但建议用 http 服务。

## 部署

推送到 GitHub 后在仓库 Settings → Pages 选择 `main` 分支根目录即可。

## 目录结构

```
index.html    页面入口
style.css     样式（移动端适配）
questions.js  题库（真心话/大冒险各 30 道）
game-core.js  权威游戏引擎（房主浏览器内运行）
mqtt-net.js   MQTT 传输层（broker 故障转移、心跳、路由）
app.js        客户端 UI 逻辑
```

## 版本说明

仓库的 `server-version` 分支保存了原始的 Node.js + WebSocket 服务端版本（需要自己部署服务器时使用）。

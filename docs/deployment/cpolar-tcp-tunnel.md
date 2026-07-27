# cpolar TCP 内网穿透

cpolar TCP 隧道只转发原始 TCP，不会替 TETR-D 改写 HTTP 或 WebSocket
请求。服务器上的 TETR-D 继续监听 `4180`，用 Windows 持久端口转发把隧道目标
`127.0.0.1:9999` 接到它：

```powershell
netsh interface portproxy add v4tov4 `
  listenaddress=127.0.0.1 listenport=9999 `
  connectaddress=127.0.0.1 connectport=4180
```

检查规则：

```powershell
netsh interface portproxy show v4tov4
```

隧道入口使用的外部地址必须加入服务器 release 外的 allowlist。以
`23.tcp.cpolar.top:14507` 为例：

```text
allowed-origins.txt: http://23.tcp.cpolar.top:14507
allowed-hosts.txt:   23.tcp.cpolar.top:14507
```

修改 allowlist 后必须重启 TETR-D，让环境变量重新加载。通过 TCP 隧道访问普通
HTTP 页面时使用 `http://23.tcp.cpolar.top:14507`，浏览器会自动使用同源的
`ws://23.tcp.cpolar.top:14507/ws`。TCP 隧道不提供 TLS；如果页面改为 HTTPS，
还需要在隧道前增加 TLS 终止，否则浏览器的 `wss://` 握手不会成功。

cpolar 免费 TCP 地址或端口变化时，必须同步更新两份 allowlist，并重新执行
外部 `/api/health` 和 WebSocket `welcome`/`auth.ok` smoke test。

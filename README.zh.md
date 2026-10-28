# no-sleep

[English](README.md) | 中文

一个让电脑在 DeepSeek Harness 运行时保持唤醒的插件，长时间任务不会因为息屏或待机被打断。设置页 **设置 → 通用** 里会多出一行。

| | |
|---|---|
| 开关 | 打开/关闭保持唤醒（按 profile 持久化） |
| 保持唤醒范围 | *屏幕与系统都不睡眠* 或 *只阻止系统睡眠*（屏幕照常熄灭，任务继续跑） |
| 状态 | 实时读取宿主状态：保持中 / 启动中 / 已关闭 / 出错，并显示辅助进程 PID |

## 工作原理

唤醒请求就是一次 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED
[| ES_DISPLAY_REQUIRED])`：由宿主端用 Windows PowerShell 的 `Add-Type` 启动一个很小的辅助进程，在其内部一个专用线程上发起。只要这个线程还在，Windows 就保持请求；进程结束，请求随之释放。因此：

- **退出 Harness** 会立即释放（辅助进程是宿主的子进程，随宿主一起结束）；
- **关掉开关** 会立即释放；
- **辅助进程意外退出** 会在设置行里报告错误，并由宿主每 30 秒的巡检重新拉起。

之所以用独立进程：宿主插件只能拿到 Harness 的 API —— 既没有 Electron/进程级原生 bridge，桌面端也不带原生 Node addon；而子进程是宿主插件确实能用的原生通道。辅助进程以隐藏方式启动，不会闪出控制台窗口。

Windows 没有可靠的用户态查询能回答「现在有没有生效的唤醒请求」（`powercfg /requests` 需要管理员权限，而且工作在另一个会话），所以设置行显示的是宿主能核实的状态：辅助进程存活，且带着所请求的标志。

## 配置

偏好写入 profile 目录下的 `no-sleep.json`（与 `cordis.patch.yml` 同级）。组合包的行只负责首次启动的初值：

```yaml
- insert:
    - id: dsh-no-sleep
      name: '@local/no-sleep'
      config:
        enabled: true   # 启动时即保持唤醒
        mode: display   # 'display'（屏幕+系统）或 'system'
```

## HTTP 路由（仅限本机 loopback）

| 方法 | 路径 | 请求体 | 结果 |
|---|---|---|---|
| `GET` | `/no-sleep/api` | — | 状态 JSON |
| `POST` | `/no-sleep/api` | `{ "enabled"?: bool, "mode"?: "display"\|"system" }` | 保存、生效并返回状态 |

来自本机 loopback 之外地址的请求一律返回 `403`：这个路由会改变主机电源状态。

## 安装与目录结构

```
plugin_manager { action: "install_bundle", target: "<绝对路径>/no-sleep" }
```

```
index.js           宿主端：路由、偏好文件、辅助进程生命周期
client.js          浏览器端：设置 → 通用 的那一行
cordis.patch.yml   插入本包的 Loader 行
package.json       dsh.bundle.patch + dsh.client 元数据
locale/en.json     显示元数据（英文）
locale/zh.json     显示元数据（中文）
icon.svg           插件图标
native/            进程内 .NET 辅助程序的参考实现（见下）
```

## 参考：进程内辅助程序

`native/` 里有一份 .NET 辅助程序（`no-sleep.cs`，由 `native/build.ps1` 构建），它在宿主自己的运行时里用专用线程发起同样的请求。只要宿主能让插件把程序集加载进自己的运行时，它就能用；如果将来的版本对插件开放了这种能力，切换到它就是最干净的方案 —— 但当前的桌面端宿主在 cordis runner 里加载插件行，并未开放。插件目前不使用它，保留 `native/build.ps1` 是因为它也把这次请求在 Win32 层的样子记录了下来。

## 许可证

[MIT](LICENSE)

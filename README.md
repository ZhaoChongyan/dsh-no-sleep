# no-sleep

English | [中文](README.zh.md)

A DeepSeek Harness plugin that keeps the computer awake while the Harness is
running, so a long agent task is not cut off by the screen turning off or the
machine going to sleep. One preference row appears in **Settings → General**.

| | |
|---|---|
| Switch | Turn wake-holding on or off (persisted per profile) |
| Keep awake | *Screen and system* or *System only* (screen off, work continues) |
| Status | Live state read from the Host: holding / starting / off / error, plus the helper process id |

## How it works

The hold is one `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED
[| ES_DISPLAY_REQUIRED])` request, made from a dedicated thread inside a small
helper process that the Host half starts with Windows PowerShell's `Add-Type`.
Windows keeps the request for as long as that thread is alive and drops it with
the process, so:

- **quitting the Harness** releases the request immediately (the helper is a
  child of the Host and ends with it);
- **turning the switch off** releases it immediately;
- **a crashed helper** is reported in the settings row and restarted by the
  Host's 30-second supervisor.

The helper is a separate process because a Host plugin only receives Harness
APIs — no Electron or process-level native bridge — and the Desktop ships no
native Node addon. A child process is the native surface a Host plugin does
have. It is spawned hidden, so no console window flashes.

Windows exposes no reliable user-mode query for "is a wake request currently
applied" (`powercfg /requests` requires elevation and runs in another session),
so the row reports what the Host can verify: the helper is alive with the
requested flags.

## Configuration

Preferences are written to `<profile>/no-sleep.json` next to the profile's
`cordis.patch.yml`. The bundle's row seeds the first run:

```yaml
- insert:
    - id: dsh-no-sleep
      name: '@local/no-sleep'
      config:
        enabled: true   # wake-holding on at startup
        mode: display   # 'display' (screen + system) or 'system'
```

## HTTP route (loopback only)

| Method | Path | Body | Result |
|---|---|---|---|
| `GET` | `/no-sleep/api` | — | status JSON |
| `POST` | `/no-sleep/api` | `{ "enabled"?: bool, "mode"?: "display"\|"system" }` | saves, applies, returns status |

Requests from anything but this machine's loopback interfaces are answered
`403`: the route changes host power state.

## Install and layout

```
plugin_manager { action: "install_bundle", target: "<abs path>/no-sleep" }
```

```
index.js           Host: route, preference file, helper process lifecycle
client.js          Browser: the Settings → General row
cordis.patch.yml   Loader row that inserts the package
package.json       dsh.bundle.patch + dsh.client metadata
locale/en.json     display metadata (English)
locale/zh.json     display metadata (Chinese)
icon.svg           plugin icon
native/            reference sources for an in-process .NET helper (see below)
```

## Reference: the in-process helper

`native/` holds a .NET helper (`no-sleep.cs`, built by `native/build.ps1`) that
makes the same request from a thread inside the Host itself. It works when a
Host can load an assembly into its own runtime, and it is the version to switch
to if a future release exposes that surface to plugins — the current Desktop
Host loads plugin rows inside its cordis runner and does not. The plugin does
not use it today; `native/build.ps1` is kept because it also documents what the
hold looks like at the Win32 level.

## License

[MIT](LICENSE)

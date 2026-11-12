# DSH 插件更新

打开「插件 → 已安装」，在「已安装插件」标题右侧点「检查更新」。有兼容的新版本时，对应插件会显示 DSH 原生的「可更新」标签和「更新」按钮。点击按钮会打开原生确认窗口，展示当前版本和目标版本。

版本检查、安装来源、安装进度和失败恢复沿用 DSH 插件管理器。检查范围是 DSH 支持在线更新的 registry 插件。本地链接、固定 Git 或压缩包来源仍按各自原有方式维护。

## 安装

从 GitHub Release 安装：

```sh
dsh plugin --profile web add https://github.com/hh5631/dsh-plugin-updater/releases/latest/download/dsh-plugin-updater.tgz
```

从本地源码安装时，在插件目录执行：

```sh
dsh plugin --profile web add "link:$PWD"
```

适配 DSH Web 0.2.2-rc.1，无需构建或额外运行依赖。若运行中的 DSH 尚未加载新插件，重启原有 Web 服务后刷新页面。

# DSH 插件更新

打开「插件 → 已安装」，点「检查 GitHub 更新」。每个插件查到可用版本后会立即显示更新按钮。可逐个更新，也可通过「全部更新」确认多个版本并查看进度。更新结果会提示是否需要重启 DSH。

支持从公开 GitHub 仓库或 GitHub Release 压缩包安装的插件。npm registry 插件由 DSH 原生插件管理器检查和更新。优先匹配稳定 Release 中对应插件的 `.tgz` 或 `.tar.gz`。GitHub 仓库来源也可以通过稳定 Git 标签或默认分支的 `package.json` 检测版本，安装时使用确切的提交。GitHub API 限流时会尝试使用本机已登录的 `gh`。本地链接和其它压缩包来源维持原有安装方式。

检查并发上限为 6 个。固定到 Git 提交的同源更新由 DSH 原生接口安装。GitHub Release 压缩包批量更新时由同一次 pnpm 操作并行下载，profile 的写入由 DSH 加锁。

## 安装

从 GitHub Release 安装

```sh
dsh plugin --profile web add https://github.com/hh5631/dsh-plugin-updater/releases/latest/download/dsh-plugin-updater.tgz
```

从本地源码安装时，在插件目录执行

```sh
dsh plugin --profile web add "link:$PWD"
```

适配 DSH Web 0.2.2-rc.3，无需构建或额外安装运行依赖。升级后重启 Web 服务，再刷新页面。

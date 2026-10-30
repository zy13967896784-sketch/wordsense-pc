# 词感 WordSense · Windows 版

把单词放进真实句子里，跟着原声读出来，再用间隔复习把句子和词一起记住。

Windows 版是原生窗口（WebView2），**不需要 Chrome / Edge，也不会启动浏览器**，不需要管理员权限。

![首页](preview/43-github-icon.png)

## 功能

- 句子跟读：原句、0.7× 慢读、逐词查词、整句翻译、录音回放、四档自评。
- 自动评分：点「自动评分」先播放例句，播完自动开始录音；读完再点一下停止并评分。
- 快刷题型：看词选义、据义择词、拼写、混合模式。
- 盲听选义：听句子选中文释义。
- 快刷 / 盲听答错会排到 3 个词后重来，直到答对为止。
- 跟读、刷词、盲听各自独立的 SRS 进度；词库页顶部切换查看。
- 今日目标圆环、打卡日历、14 天统计、每日提醒、数据备份。
- 首页只有一个词书下拉框；词库：四级 4717 / 六级 7214 / 考研 7673 / 雅思 7650 / 托福 7693，去重 8531 词。

## 下载运行

从仓库的 `dist/` 取：

- `词感.exe`
- `WordSense-1.3.0-win64.zip`（exe + 使用说明）
- `使用说明.txt`

双击 `词感.exe` 即可，**不要以管理员身份运行**。

需要 Windows 10/11 的 **Microsoft Edge WebView2 Runtime**；绝大多数系统已有。如果提示缺少，安装：

<https://developer.microsoft.com/microsoft-edge/webview2/>

学习记录保存在：

```text
%LOCALAPPDATA%\WordSenseNative
```

首次启动会自动迁移旧版 `%LOCALAPPDATA%\WordSense\profile` 中的记录。

## 从源码构建

需要 .NET Framework 4.8 的 `csc.exe`；仓库已经包含 `tools/webview2` SDK。

```powershell
powershell -ExecutionPolicy Bypass -File tools\package.ps1
```

输出：

```text
dist\词感.exe
dist\WordSense-1.3.0-win64.zip
```

## 相关仓库

- Android 版：<https://github.com/zy13967896784-sketch/wordsense-android>
- 本仓库：<https://github.com/zy13967896784-sketch/wordsense-pc>

## 数据与隐私

所有学习记录只存在本机，不上传；录音只用于本地回放。

词库为自建数据，例句为学习用改写，仅供个人学习使用。

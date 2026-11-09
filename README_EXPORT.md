# FIT MOTION Android 项目导出包

这个压缩包包含两个可直接使用的部分：

```text
fit-motion/
  android-studio/     Android Studio Gradle 工程，可直接打开
  src/                网页源码
  index.html          网页源码入口
  web-dist/index.html 已完成构建的单文件网页
  FitMotion.apk       已签名 APK
  android/            原有 javac/aapt2 自定义构建工程（备用）
```

## 1. 用 Android Studio 打开

推荐使用 Android Studio 打开：

```text
fit-motion/android-studio
```

环境要求：

```text
Android Studio
JDK 17
Android SDK Platform 34
Gradle 8.7（wrapper 已包含）
```

首次打开时 Android Studio 会自动同步 Gradle 和下载依赖。

构建 Debug APK：

```text
Build
  → Build Bundle(s) / APK(s)
  → Build APK(s)
```

或者命令行：

```powershell
cd fit-motion\android-studio
.\gradlew.bat :app:assembleDebug
```

输出位置：

```text
android-studio\app\build\outputs\apk\debug\app-debug.apk
```

## 2. 包名和版本

```text
applicationId: com.fitmotion.app
namespace:     com.fitmotion.app
minSdk:        29
targetSdk:     30
compileSdk:    34
versionCode:   1
versionName:   1.0.0
```

WebView 加载：

```text
android-studio/app/src/main/assets/www/index.html
```

## 3. 修改网页源码

网页源码在：

```text
fit-motion/src/
fit-motion/index.html
```

安装依赖并构建：

```powershell
cd fit-motion
npm install
npm run build
```

构建后的单文件网页是：

```text
fit-motion/dist/index.html
```

## 4. 更新 Android 内的网页

网页构建完成后，把：

```text
fit-motion/dist/index.html
```

复制到：

```text
fit-motion/android-studio/app/src/main/assets/www/index.html
```

然后重新构建 APK。

## 5. 已签名 APK

压缩包根目录包含一个已签名 APK：

```text
fit-motion/FitMotion.apk
```

可以直接安装测试。

这个 APK 使用项目里的开发签名。正式发布前，请用 Android Studio 生成你自己的 release keystore：

```text
Build
  → Generate Signed Bundle / APK
```

不要把正式签名 keystore 提交到公开仓库。

## 6. 原有自定义构建工程

`fit-motion/android/` 是原来的：

```text
javac
aapt2
d8
apksigner
```

自定义构建方式，包含 `build-apk.mjs`。

如果你不想用 Android Studio，也可以继续使用这个工程。它依赖：

```text
JDK
Android SDK Build Tools
项目内的 tools/sdk/android-11
```

运行：

```powershell
cd fit-motion
npm run build
node android\build-apk.mjs
```

## 7. 注意事项

- 当前 `targetSdk` 是 30，Android 13+ 的通知权限需要在系统设置里允许。
- 后台导出使用前台服务。
- 全屏预览通过 Android WebView 的 `onShowCustomView` 实现。
- 正式发布前建议把 `targetSdk` 升到 34 并重新测试通知、前台服务和存储权限。
- 网页里的地图使用 OpenStreetMap / OpenFreeMap 数据，需保留地图署名。

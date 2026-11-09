import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const android = path.join(root, 'android');
const sdk = path.join(root, 'tools', 'sdk', 'android-11');
const build = path.join(android, 'build');
const dist = path.join(root, 'dist');
const javaHome = process.env.JAVA_HOME || 'D:\\Jdk\\jdk';
const java = path.join(javaHome, 'bin', 'java.exe');
const javac = path.join(javaHome, 'bin', 'javac.exe');
const keytool = path.join(javaHome, 'bin', 'keytool.exe');
const androidJar = path.join(sdk, 'android.jar');
const aapt2 = path.join(sdk, 'aapt2.exe');
const d8Jar = path.join(sdk, 'lib', 'd8.jar');
const apksignerJar = path.join(sdk, 'lib', 'apksigner.jar');
const zipalign = path.join(sdk, 'zipalign.exe');
const keystore = path.join(android, 'fitmotion.keystore');
const apkOut = path.join(dist, 'FitMotion.apk');

for (const tool of [java, javac, keytool, androidJar, aapt2, d8Jar, apksignerJar, zipalign]) {
  if (!fs.existsSync(tool)) throw new Error(`Missing Android tool: ${tool}`);
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  throw new Error('dist/index.html not found. Run npm run build first.');
}

// 不做整体清理：javac/d8 全量重编译会覆盖旧产物；删大批量文件会触发删除保护。
// 源码列表变化时手动清一下 android/build 即可。
fs.mkdirSync(path.join(build, 'gen'), { recursive: true });
fs.mkdirSync(path.join(build, 'classes'), { recursive: true });
fs.mkdirSync(path.join(build, 'dex'), { recursive: true });
fs.mkdirSync(path.join(android, 'assets', 'www'), { recursive: true });
fs.copyFileSync(path.join(dist, 'index.html'), path.join(android, 'assets', 'www', 'index.html'));

// 版本号单源化：package.json 的 version 是唯一来源。
// versionCode 用日期流水（如 20261109），每次构建当天递增可见性一致。
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '1.0.0';
const todayStamp = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));

run(aapt2, ['compile', '--dir', path.join(android, 'res'), '-o', path.join(build, 'res.zip')], android);
run(aapt2, [
  'link',
  '-o', path.join(build, 'app-unsigned.apk'),
  '-I', androidJar,
  '--manifest', path.join(android, 'AndroidManifest.xml'),
  '-A', path.join(android, 'assets'),
  '--java', path.join(build, 'gen'),
  '--min-sdk-version', '29',
  '--target-sdk-version', '34',
  '--version-code', String(todayStamp),
  '--version-name', pkgVersion,
  path.join(build, 'res.zip'),
], android);

const javaSources = [
  path.join(android, 'java', 'com', 'fitmotion', 'app', 'AudioMixer.java'),
  path.join(android, 'java', 'com', 'fitmotion', 'app', 'MainActivity.java'),
  path.join(android, 'java', 'com', 'fitmotion', 'app', 'NativeExporter.java'),
  path.join(android, 'java', 'com', 'fitmotion', 'app', 'NativeScene.java'),
  path.join(android, 'java', 'com', 'fitmotion', 'app', 'ShareProvider.java'),
  path.join(android, 'java', 'com', 'fitmotion', 'app', 'NativePreview.java'),
  path.join(android, 'java', 'com', 'fitmotion', 'app', 'NativeVectorMap.java'),
  path.join(android, 'java', 'com', 'fitmotion', 'app', 'Mvt.java'),
  path.join(android, 'java', 'com', 'fitmotion', 'app', 'ExportService.java'),
  path.join(build, 'gen', 'com', 'fitmotion', 'app', 'R.java'),
];
run(javac, [
  '-encoding', 'UTF-8',
  '-source', '8',
  '-target', '8',
  '-bootclasspath', androidJar,
  '-d', path.join(build, 'classes'),
  ...javaSources,
], android);

const classes = fs.readdirSync(path.join(build, 'classes', 'com', 'fitmotion', 'app'))
  .filter((name) => name.endsWith('.class'))
  .map((name) => path.join(build, 'classes', 'com', 'fitmotion', 'app', name));
run(java, [
  '-cp', d8Jar,
  'com.android.tools.r8.D8',
  '--release',
  '--lib', androidJar,
  '--output', path.join(build, 'dex'),
  ...classes,
], android);

run('python', [
  '-c',
  'import sys, zipfile; z=zipfile.ZipFile(sys.argv[1], "a", zipfile.ZIP_DEFLATED); z.write(sys.argv[2], "classes.dex"); z.close()',
  path.join(build, 'app-unsigned.apk'),
  path.join(build, 'dex', 'classes.dex'),
], android);

run(zipalign, [
  '-f',
  '-p',
  '4',
  path.join(build, 'app-unsigned.apk'),
  path.join(build, 'app-aligned.apk'),
], android);

if (!fs.existsSync(keystore)) {
  run(keytool, [
    '-genkeypair',
    '-v',
    '-keystore', keystore,
    '-storepass', 'fitmotion',
    '-alias', 'fitmotion',
    '-keypass', 'fitmotion',
    '-dname', 'CN=FIT Motion,O=FIT Motion,C=CN',
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
  ], android);
}

fs.mkdirSync(dist, { recursive: true });
run(java, [
  '-jar', apksignerJar,
  'sign',
  '--ks', keystore,
  '--ks-pass', 'pass:fitmotion',
  '--key-pass', 'pass:fitmotion',
  '--min-sdk-version', '24',
  '--v1-signing-enabled', 'true',
  '--v2-signing-enabled', 'true',
  '--v3-signing-enabled', 'false',
  '--out', apkOut,
  path.join(build, 'app-aligned.apk'),
], android);
run(java, ['-jar', apksignerJar, 'verify', '--verbose', '--print-certs', apkOut], android);

const size = fs.statSync(apkOut).size;
console.log(`APK ready: ${apkOut} (${(size / 1024 / 1024).toFixed(2)} MB)`);

function run(command, args, cwd) {
  const needsShell = /\.(bat|cmd)$/i.test(command);
  const result = spawnSync(needsShell ? `"${command}"` : command, needsShell ? args.map(quote) : args, {
    cwd,
    stdio: 'inherit',
    shell: needsShell,
    env: { ...process.env, JAVA_HOME: javaHome },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (${result.status}): ${command}`);
}

function quote(value) {
  if (value === '') return '""';
  return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

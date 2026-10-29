#!/usr/bin/env python3
"""Build with the cached Kotlin/Android CLI tools, without Gradle's local daemon.
Uses the same declared app dependencies; never reuses the previous APK's code.
"""
import os, subprocess, zipfile, shutil, re
from pathlib import Path
root=Path(__file__).resolve().parents[1]
os.chdir(root)
subprocess.run(['node', 'tests/webview-compat.mjs'], check=True)
tools=Path(os.environ.get('COCOA_ANDROID_TOOLS',str(Path.home()/'.android/cocoastream-tools')))
jdk=Path(os.environ.get('JAVA_HOME',str(tools/'jdk')))
sdk=Path(os.environ.get('ANDROID_HOME',str(tools/'android-sdk')))
bt=sdk/'build-tools/34.0.0'
cache=Path.home()/'.gradle/caches/modules-2/files-2.1'
out=root/'build/offline'; out.mkdir(parents=True,exist_ok=True)
env=dict(os.environ, JAVA_HOME=str(jdk), PATH=str(jdk/'bin')+':'+os.environ['PATH'])
def run(*args):
 print('+',str(args[0]),flush=True)
 subprocess.run([str(x) for x in args],check=True,env=env)
def jar(group,artifact,version):
 matches=list((cache/group/artifact/version).glob('*/*.jar'))
 if len(matches)!=1:raise RuntimeError(f'Missing or ambiguous cached dependency: {group}:{artifact}:{version}')
 return matches[0]
android=sdk/'platforms/android-34/android.jar'
compiler=[jar('org.jetbrains.kotlin','kotlin-compiler-embeddable','1.9.24'),jar('org.jetbrains.kotlin','kotlin-stdlib','1.9.24'),jar('org.jetbrains.kotlin','kotlin-script-runtime','1.9.24'),jar('org.jetbrains.kotlin','kotlin-reflect','1.6.10'),jar('org.jetbrains.intellij.deps','trove4j','1.0.20200330')]
annotations=list((cache/'org.jetbrains/annotations').glob('*/*/*.jar'))[-1]
compiler.append(annotations)
libs=[jar('com.google.guava','guava','33.0.0-android'),jar('com.google.guava','failureaccess','1.0.2'),jar('org.jetbrains.kotlin','kotlin-stdlib','1.9.24'),jar('com.squareup.okhttp3','okhttp','4.12.0'),jar('com.squareup.okio','okio-jvm','3.6.0'),jar('org.libtorrent4j','libtorrent4j','2.1.0-35'),annotations]
for group in ['androidx.annotation','androidx.collection','com.google.guava','com.google.errorprone','com.google.code.findbugs','com.google.j2objc','androidx.concurrent','androidx.arch.core','androidx.lifecycle']:
 for p in (cache/group).glob('*/*/*/*.jar'):
  if not any(q.name.split('-')[0]==p.name.split('-')[0] for q in libs):libs.append(p)
res=[]; packages=[]
for aar in sorted(cache.glob('*/*/*/*/*.aar')):
 dest=out/'dependencies'/aar.stem
 if not dest.exists():
  dest.mkdir(parents=True)
  with zipfile.ZipFile(aar) as z:z.extractall(dest)
 if (dest/'classes.jar').exists():libs.append(dest/'classes.jar')
 for p in (dest/'libs').glob('*.jar'):libs.append(p)
 manifest=dest/'AndroidManifest.xml'
 if manifest.exists():
  match=re.search(r'package="([^"]+)"',manifest.read_text())
  if match:packages.append(match[1])
 if (dest/'res').is_dir():
  compiled=dest/'resources.zip'
  if not compiled.exists():run(bt/'aapt2','compile','--dir',dest/'res','-o',compiled)
  res.extend(['-R',compiled])
compiled=out/'app-res.zip'
run(bt/'aapt2','compile','--dir',root/'app/src/main/res','-o',compiled)
java=out/'java';java.mkdir(exist_ok=True)
manifest=(root/'app/src/main/AndroidManifest.xml').read_text().replace('<manifest xmlns:android=', '<manifest package="app.cocoastream.android" xmlns:android=')
manifest=manifest.replace('<application','<uses-sdk android:minSdkVersion="24" android:targetSdkVersion="34"/><application',1)
(out/'AndroidManifest.xml').write_text(manifest)
resource_apk=out/'resources.apk'
run(bt/'aapt2','link','-o',resource_apk,'--manifest',out/'AndroidManifest.xml','-I',android,'--auto-add-overlay','--java',java,'--extra-packages',':'.join(packages),'--version-code','7','--version-name','1.2.1',*res,'-R',compiled)
classes=out/'classes'
if classes.exists():shutil.rmtree(classes)
classes.mkdir()
run(jdk/'bin/javac','-source','8','-target','8','-classpath',android,'-d',classes,*java.rglob('*.java'),*root.glob('app/src/main/java/**/*.java'))
classpath=':'.join(str(p) for p in [android,classes,*libs])
run(jdk/'bin/java','-Xmx1g','-cp',':'.join(map(str,compiler)),'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler','-no-stdlib','-no-reflect','-jvm-target','17','-classpath',classpath,'-d',classes,*root.glob('app/src/main/java/**/*.kt'))
code=out/'app.jar'
run(jdk/'bin/jar','cf',code,'-C',classes,'.')
dex=out/'dex';dex.mkdir(exist_ok=True)
for p in dex.glob('*.dex'):p.unlink()
run(jdk/'bin/java','-Xmx1g','-cp',jar('com.android.tools.build','builder','8.5.2'),'com.android.tools.r8.D8','--min-api','24','--lib',android,'--output',dex,code,*libs)
unsigned=out/'unsigned.apk'
shutil.copy2(resource_apk,unsigned)
with zipfile.ZipFile(unsigned,'a',compression=zipfile.ZIP_DEFLATED) as z:
 for p in dex.glob('*.dex'):z.write(p,p.name)
 for p in (root/'app/src/main/assets').rglob('*'):
  if p.is_file():z.write(p,'assets/'+str(p.relative_to(root/'app/src/main/assets')))
 for p in (root/'app/src/main/jniLibs').rglob('*.so'):z.write(p,'lib/'+str(p.relative_to(root/'app/src/main/jniLibs')),compress_type=zipfile.ZIP_STORED)
 # Merge Java resources needed by network clients (including OkHttp's suffix database).
 names=set(z.namelist())
 for lib in libs:
  with zipfile.ZipFile(lib) as source:
   for name in source.namelist():
    if name.endswith('/') or name.endswith('.class') or name.startswith('META-INF/') or name in names:continue
    z.writestr(name,source.read(name));names.add(name)
aligned=out/'aligned.apk'
run(bt/'zipalign','-f','-p','4',unsigned,aligned)
keys=Path.home()/'.local/share/cocoastream/signing';keys.mkdir(parents=True,exist_ok=True,mode=0o700)
keystore=keys/'cocoastream.p12'
if not keystore.exists():
 run(jdk/'bin/keytool','-genkeypair','-keystore',keystore,'-storepass','android','-keypass','android','-alias','cocoastream','-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=CocoaStream Android, O=CocoaStream, C=US')
 keystore.chmod(0o600)
apk=root/'CocoaStream.apk'
run(bt/'apksigner','sign','--ks',keystore,'--ks-key-alias','cocoastream','--ks-pass','pass:android','--key-pass','pass:android','--out',apk,aligned)
run(bt/'apksigner','verify','--verbose',apk)
run('python3',root/'tests/apk-integrity.py')
print(f'Built {apk} ({apk.stat().st_size/1024/1024:.1f} MiB)',flush=True)

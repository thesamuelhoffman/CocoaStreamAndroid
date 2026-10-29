#!/usr/bin/env python3
"""Check APK CRCs and essential transitive runtime classes, not just its signature."""
import struct,sys,zipfile
from pathlib import Path

def classes(data):
 u=lambda p:struct.unpack_from('<I',data,p)[0]
 def string(p):
  while data[p]&128:p+=1
  p+=1
  return data[p:data.index(b'\0',p)].decode('utf8','replace')
 strings=[string(u(u(60)+4*i)) for i in range(u(56))]
 types=[strings[u(u(68)+4*i)] for i in range(u(64))]
 return {types[u(u(100)+32*i)] for i in range(u(96))}
apk=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parents[1]/'CocoaStream.apk'
with zipfile.ZipFile(apk) as z:
 assert z.testzip() is None,'Corrupt ZIP entry'
 definitions=set()
 for name in z.namelist():
  if name.endswith('.dex'):definitions.update(classes(z.read(name)))
 required=['app/cocoastream/android/MainActivity','androidx/webkit/WebViewAssetLoader',
 'okhttp3/OkHttpClient','okio/Buffer','kotlin/jvm/internal/Intrinsics',
 'androidx/concurrent/futures/ResolvableFuture','androidx/lifecycle/Lifecycle',
 'androidx/lifecycle/LifecycleOwner','androidx/arch/core/internal/SafeIterableMap']
 missing=[name for name in required if 'L'+name+';' not in definitions]
 assert not missing,'Missing runtime dependencies: '+', '.join(missing)
 print('APK CRCs and essential Android runtime classes PASS')

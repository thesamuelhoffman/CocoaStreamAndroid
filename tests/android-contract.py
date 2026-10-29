#!/usr/bin/env python3
"""Guard first-run signup, safe Linux add-on defaults, launcher, and playback window."""
import json
import re
from pathlib import Path
from urllib.parse import unquote

root=Path(__file__).resolve().parents[1]
app=(root/'app/src/main/assets/app/app.js').read_text()
accounts=(root/'app/src/main/java/app/cocoastream/android/Accounts.kt').read_text()
bridge=(root/'app/src/main/java/app/cocoastream/android/Bridge.kt').read_text()
webbridge=(root/'app/src/main/assets/app/bridge.js').read_text()
player=(root/'app/src/main/java/app/cocoastream/android/PlayerActivity.kt').read_text()
cast=(root/'app/src/main/java/app/cocoastream/android/Cast.kt').read_text()
manifest=(root/'app/src/main/AndroidManifest.xml').read_text()
defaults=json.loads((root/'app/src/main/assets/app/defaults.json').read_text())

assert "renderAuth(await window.cocoa.auth.hasAccounts() ? 'login' : 'register')" in app
assert '"auth:has-accounts" -> accounts.hasAccounts()' in bridge
assert 'hasAccounts: function ()' in webbridge
assert 'id=="guest")return null' in accounts
assert 'migrateGuestFiles(id)' in accounts, 'Keep guest library data when onboarding into a profile'
assert 'minlength="8"' in app and 'maxlength="24"' in app
assert 'setBufferDurationsMs(20_000,20_000,1_000,2_000)' in player
assert 'setBackBuffer(5_000,true)' in player
assert 'castingMimeType()' in player and 'private fun google(device:JSONObject,url:String,title:String,mime:String)' in cast
assert 'CocoaStreamCastDiscovery' in cast and 'isCasting():Boolean = active != null' in cast
assert 'android.intent.category.LAUNCHER' in manifest and 'android:icon="@mipmap/ic_launcher"' in manifest
names={a.get('name') for a in defaults['addons']}
expected={'Star Wars Universe','Cartoon Network','Flix-Streams Free','Asian-TV'}
assert expected <= names, 'Linux custom add-ons missing from Android defaults'
for addon in defaults['addons']:
    url=addon.get('url','')
    decoded=url
    for _ in range(3): decoded=unquote(decoded)
    assert not re.search(r'(auth[_-]?token|access[_-]?token|api[_-]?key|password|secret|bearer|/p\.[a-z0-9_-]{12,}/)',decoded,re.I), f'Credential-like value in public add-on URL: {addon.get("key")}'
print('First-run create-account, guest-data migration, launcher, playback window and safe add-on defaults PASS')

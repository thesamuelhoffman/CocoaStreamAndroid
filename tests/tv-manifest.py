import xml.etree.ElementTree as ET
root=ET.parse('app/src/main/AndroidManifest.xml').getroot()
n='{http://schemas.android.com/apk/res/android}'
features={x.get(n+'name'):x.get(n+'required') for x in root.findall('uses-feature')}
assert features.get('android.hardware.touchscreen')=='false'
assert features.get('android.hardware.wifi')=='false','Ethernet-only TVs must not be excluded'
assert features.get('android.software.leanback')=='false','TV capability cannot exclude phones'
categories={x.get(n+'name') for x in root.findall('.//category')}
assert 'android.intent.category.LAUNCHER' in categories
assert 'android.intent.category.LEANBACK_LAUNCHER' in categories
print('Phone and TV launcher declarations, optional touchscreen/Wi-Fi PASS')

import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
const {parse}=createRequire(import.meta.url)('acorn');
for(const name of readdirSync('app/src/main/assets/app').filter(x=>x.endsWith('.js'))) {
 try {parse(readFileSync('app/src/main/assets/app/'+name,'utf8'),{ecmaVersion:2020,sourceType:'module'});}
 catch(error){throw new Error(name+' cannot load in the Android 11 emulator WebView: '+error.message);}
}
console.log('All app JavaScript parses as ES2020 for Chromium 83 PASS');

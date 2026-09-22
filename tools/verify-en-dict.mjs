// Verify the inlined EN_DICT contains the SSH-port UI strings.
import { readFileSync } from 'node:fs'

const line = readFileSync('lib/client.js', 'utf8')
  .split('\n')
  .find((l) => l.trimStart().startsWith('const EN_DICT = '))

const json = line.slice(line.indexOf('= ') + 2).trim().replace(/;\s*$/, '')
const dict = JSON.parse(json)

const wanted = [
  '443（穿墙）',
  '22（标准）',
  ' 已配置',
  '⚠️ 未配置',
  '连接失败（端口 ',
  '；若是网络封锁 22 端口，请改用 443。',
  ' 或已配置 Gitee 令牌',
]

let bad = 0
for (const k of wanted) {
  const ok = k in dict
  if (!ok) bad++
  console.log((ok ? 'PRESENT ' : 'MISSING ') + JSON.stringify(k) + (ok ? ' -> ' + JSON.stringify(dict[k]) : ''))
}
console.log('dict keys:', Object.keys(dict).length)
process.exit(bad ? 1 : 0)

const bridge = window.dshDesktop?.pluginRecovery
const summary = document.querySelector('#summary')
const operation = document.querySelector('#operation')
const attempt = document.querySelector('#attempt')
const reason = document.querySelector('#reason')
const notice = document.querySelector('#notice')
const retry = document.querySelector('#retry')
const exportButton = document.querySelector('#export')

const reasons = {
  'unsupported-journal-version': '恢复日志版本不受支持',
  'journal-invalid': '恢复日志无效',
  'snapshot-missing': '旧环境快照缺失',
  'snapshot-invalid': '旧环境快照无效',
  'snapshot-root-mismatch': '快照不属于当前 Profile',
  'snapshot-path-invalid': '快照包含不安全路径',
  'snapshot-hash-mismatch': '快照完整性校验失败',
  'profile-lock-busy': '另一个进程仍占用插件环境',
  'host-stop-failed': '旧 Host 无法安全停止',
  'profile-restore-failed': 'Profile 文件恢复失败',
  'package-restore-failed': '旧依赖恢复失败',
  'host-start-failed': '旧 Host 无法重新启动',
  'runtime-verification-failed': '旧运行能力验证失败',
  'diagnostic-export-failed': '诊断导出失败',
}

let current = null

function render(snapshot) {
  current = snapshot
  if (snapshot === null) {
    summary.textContent = '没有可读取的恢复记录。请重新启动应用或联系支持。'
    operation.textContent = '—'
    attempt.textContent = '—'
    reason.textContent = '恢复记录不可用'
    retry.disabled = true
    exportButton.disabled = true
    return
  }
  operation.textContent = snapshot.operationId
  attempt.textContent = String(snapshot.attempt)
  reason.textContent = snapshot.recoveryReasonCode === null
    ? '—'
    : reasons[snapshot.recoveryReasonCode] ?? snapshot.recoveryReasonCode
  exportButton.disabled = !snapshot.canExportDiagnostics
  retry.disabled = !snapshot.canRetry
  if (snapshot.phase === 'recovering') {
    summary.textContent = '正在恢复上一次操作前的插件环境，请不要退出应用。'
  } else if (snapshot.phase === 'recovery-failed') {
    summary.textContent = '旧环境尚未通过完整验证。你可以重试，或先导出不含本地路径和文件内容的诊断。'
  } else {
    summary.textContent = '旧插件环境已经恢复，正在进入普通桌面。'
  }
}

retry.addEventListener('click', async () => {
  if (bridge === undefined || current === null) return
  retry.disabled = true
  exportButton.disabled = true
  notice.textContent = '正在重新恢复并验证旧环境…'
  try {
    render(await bridge.retry({ operationId: current.operationId }))
    notice.textContent = current?.phase === 'rolled-back' ? '恢复完成。' : '恢复仍未通过，请查看新的失败原因。'
  } catch {
    notice.textContent = '恢复请求未完成，请再次尝试或导出诊断。'
    retry.disabled = false
    exportButton.disabled = false
  }
})

exportButton.addEventListener('click', async () => {
  if (bridge === undefined || current === null) return
  exportButton.disabled = true
  notice.textContent = '请选择诊断文件保存位置…'
  try {
    const result = await bridge.exportDiagnostics({ operationId: current.operationId })
    notice.textContent = result.status === 'saved'
      ? `诊断已保存：${result.filename}`
      : '已取消导出。'
  } catch {
    notice.textContent = '诊断导出失败。'
  } finally {
    exportButton.disabled = false
  }
})

if (bridge === undefined) {
  notice.textContent = '桌面恢复桥接不可用。'
  render(null)
} else {
  bridge.onState(render)
  bridge.getState().then(render, () => {
    notice.textContent = '无法读取恢复状态。'
    render(null)
  })
}

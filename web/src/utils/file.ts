/**
 * 文件读取工具：NUpload 手动模式选中的 File → 纯 base64（去 dataURL 前缀），
 * 供回单上传（orders.uploadVoucher）与发票登记（admin.invoices.issue）等
 * contentBase64 接口共用（任务 14 首创于 console/OrderDetail，任务 15 抽出）。
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

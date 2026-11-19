/** 清洗 Windows OCR 的输出：汉字之间会插空格（"近 年 来" → "近年来"）。 */
export function normalize(text) {
  return String(text || '')
    .replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

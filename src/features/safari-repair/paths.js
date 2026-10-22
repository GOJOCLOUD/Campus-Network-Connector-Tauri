/**
 * 功能模块内的路径解析。
 *
 * 目录约定:
 *   <项目根>/src/features/<功能名>/     ← 功能模块(自包含)
 *   <项目根>/vendor/                     ← 运行时依赖(参考库、字体解析器、注入脚本)
 *
 * 模块深度会变(嵌套目录/单测子目录),所以路径一律从这里算,不要在业务代码里
 * 写 `path.join(__dirname, '..', '..', '..')` 这种。
 */
const path = require('path');

/** 项目根目录 */
const ROOT = path.resolve(__dirname, '..', '..', '..');
/** 运行时依赖目录 */
const VENDOR = path.join(ROOT, 'vendor');

module.exports = {
  ROOT,
  VENDOR,
  /** 取 vendor 下的某个文件 */
  vendor: (name) => path.join(VENDOR, name),
};

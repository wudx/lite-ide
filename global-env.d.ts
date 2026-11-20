// 仓库级通配模块声明：各包 tsc 直接编译跨包源码（workspace 以源码互引），
// 放在 base 的 files 里保证每个包的 typecheck 都能解析 `?raw` 导入。
declare module '*?raw' {
  const content: string
  export default content
}

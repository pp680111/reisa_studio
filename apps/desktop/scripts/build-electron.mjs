import { build } from 'esbuild';
// @lancedb/lancedb 是原生依赖（napi 预编译），必须保持外部引用并在安装包中携带；
// apache-arrow 同样外部化，避免与 lancedb 内部解析产生双实例（迁移设计文档 §10.1）。
await build({
  entryPoints: ['src/main/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', '@lancedb/lancedb', 'apache-arrow'],
  outfile: 'dist-electron/main.cjs',
});
await build({
  entryPoints: ['src/preload/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: 'dist-electron/preload.cjs',
});

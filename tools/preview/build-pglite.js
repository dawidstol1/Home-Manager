require('esbuild').build({
  entryPoints: ['pglite-entry.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  outfile: 'pglite-bundle.js', logLevel: 'error',
  plugins: [{
    name: 'empty-node',
    setup(b) {
      b.onResolve({ filter: /^(node:)?(fs|fs\/promises|path|crypto|url|module|os|child_process|worker_threads|util|stream|zlib)$/ }, (a) => ({ path: a.path, namespace: 'empty' }));
      b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export default {}; export const createRequire = () => () => ({});', loader: 'js' }));
    },
  }],
}).then(() => console.log('pglite bundle ok'));


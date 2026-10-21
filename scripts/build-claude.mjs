// Monta a página do Rotinas para publicar como artifact no Claude (claude.ai).
// Entrada: dist-claude/ (vite build --mode claude). Saída: release/rotinas-claude/index.html.
//
// O artifact recebe só o conteúdo da página (a plataforma acrescenta <!doctype>, <head> e <body>)
// e só executa scripts embutidos na própria página: o JS e o CSS do build vão inteiros aqui
// dentro, e as fontes já vêm embutidas no CSS pelo Vite.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist-claude';
const outDir = 'release/rotinas-claude';
const html = readFileSync(join(dist, 'index.html'), 'utf8');

const script = /<script type="module"[^>]*src="\.\/([^"]+)"[^>]*><\/script>/.exec(html)?.[1];
const style = /<link rel="stylesheet"[^>]*href="\.\/([^"]+)"[^>]*>/.exec(html)?.[1];
if (!script || !style) {
  console.error('Não encontrei o JS ou o CSS em dist-claude/index.html. Rode "vite build --mode claude" antes.');
  process.exit(1);
}

// Nada dentro do JS/CSS pode fechar a tag que os contém.
const js = readFileSync(join(dist, script), 'utf8').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const css = readFileSync(join(dist, style), 'utf8').replace(/<\/style/gi, '<\\/style');

const page = [
  '<title>Rotinas</title>',
  `<style>\n${css}\n</style>`,
  '<noscript>O Rotinas precisa de JavaScript para funcionar.</noscript>',
  '<div id="root"></div>',
  `<script type="module">\n${js}\n</script>`,
  '',
].join('\n');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), page);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.info(`Pronto: ${outDir}/index.html (${kb(Buffer.byteLength(page))}; JS ${kb(Buffer.byteLength(js))}, CSS ${kb(Buffer.byteLength(css))}).`);

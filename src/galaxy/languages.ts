/** Language colours (GitHub linguist, lightened where too dark for space) and extension mapping. */

export const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#4b8bbe',
  Rust: '#dea584',
  Go: '#00add8',
  Java: '#b07219',
  'C#': '#2ea043',
  'C++': '#f34b7d',
  C: '#a8b9cc',
  HTML: '#e34c26',
  CSS: '#8f6fd8',
  SCSS: '#c6538c',
  Shell: '#89e051',
  Ruby: '#e0457b',
  PHP: '#8892bf',
  Swift: '#f05138',
  Kotlin: '#a97bff',
  Dart: '#00b4ab',
  Lua: '#6c7cff',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  HCL: '#844fba',
  Elixir: '#b48ade',
  Haskell: '#8e7cc3',
  Scala: '#dc322f',
  Zig: '#ec915c',
  Nix: '#7e7eff',
  'Jupyter Notebook': '#da5b0b',
  Dockerfile: '#5ba3e0',
  Markdown: '#b0bec5',
  JSON: '#cbcb41',
  YAML: '#cb171e',
  QML: '#44a51c',
  GDScript: '#478cbf',
};

export const UNKNOWN_COLOR = '#8b949e';

export const colorFor = (language: string | null | undefined) =>
  (language && LANGUAGE_COLORS[language]) || UNKNOWN_COLOR;

const EXTENSIONS: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  cs: 'C#',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  hh: 'C++',
  c: 'C',
  h: 'C',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  rb: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kt: 'Kotlin',
  kts: 'Kotlin',
  dart: 'Dart',
  lua: 'Lua',
  vue: 'Vue',
  svelte: 'Svelte',
  tf: 'HCL',
  hcl: 'HCL',
  ex: 'Elixir',
  exs: 'Elixir',
  hs: 'Haskell',
  scala: 'Scala',
  zig: 'Zig',
  nix: 'Nix',
  ipynb: 'Jupyter Notebook',
  md: 'Markdown',
  mdx: 'Markdown',
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  qml: 'QML',
  gd: 'GDScript',
};

/** Languages that are prose or data: they colour moons but never decide a planet's colour. */
const NON_CODE = new Set(['Markdown', 'JSON', 'YAML']);

export function languageForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return 'Dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

export const isCodeLanguage = (language: string | null) => language !== null && !NON_CODE.has(language);

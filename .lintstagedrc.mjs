const config = {
  '*.{ts,tsx,js,mjs,cjs}': ['eslint --fix --max-warnings=0 --no-warn-ignored', 'prettier --write'],
  '*.{json,md,yml,yaml,css}': ['prettier --write'],
  'feature_list.json': ['tsx scripts/validate-feature-list.ts'],
}

export default config

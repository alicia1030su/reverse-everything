import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
  {ignores:['**/dist/**','**/node_modules/**','data/**','test-results/**','playwright-report/**','coverage/**']},
  {files:['**/*.{ts,tsx}'],extends:[tseslint.configs.recommended],languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{...globals.browser,...globals.node}},rules:{'@typescript-eslint/no-unused-vars':['warn',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}],'@typescript-eslint/no-explicit-any':'error','no-constant-binary-expression':'error'}},
  {files:['**/*.{js,mjs,cjs}'],languageOptions:{globals:globals.node},rules:{'no-unused-vars':['warn',{argsIgnorePattern:'^_'}]}}
);
